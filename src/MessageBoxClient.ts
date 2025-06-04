/**
 * @file MessageBoxClient.ts
 * @description
 * Provides the `MessageBoxClient` class — a secure client library for sending and receiving messages
 * via a Message Box Server over HTTP and WebSocket. Messages are authenticated, optionally encrypted,
 * and routed using identity-based addressing based on BRC-2/BRC-42/BRC-43 protocols.
 *
 * Core Features:
 * - Authenticated message transport using identity keys
 * - Deterministic message ID generation via HMAC (BRC-2)
 * - AES-256-GCM encryption using ECDH shared secrets derived via BRC-42/BRC-43
 * - Support for sending messages to self (`counterparty: 'self'`)
 * - Live message streaming using WebSocket rooms
 * - Optional plaintext messaging with `skipEncryption`
 * - Overlay host discovery and advertisement broadcasting via SHIP
 * - MessageBox-based organization and acknowledgment system
 *
 * See BRC-2 for details on the encryption scheme: https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md
 *
 * @module MessageBoxClient
 * @author Project Babbage
 * @license Open BSV License
 */

import {
  WalletClient,
  AuthFetch,
  LookupResolver,
  TopicBroadcaster,
  Utils,
  Transaction,
  PushDrop,
  BEEF,
  LockingScript,
  HexString
} from '@bsv/sdk'
import { AuthSocketClient } from '@bsv/authsocket-client'
import { Logger } from './Utils/logger.js'
import { AcknowledgeMessageParams, EncryptedMessage, ListMessagesParams, MessageBoxClientOptions, PeerMessage, SendMessageParams, SendMessageResponse } from './types.js'

const DEFAULT_MAINNET_HOST = 'https://messagebox.babbage.systems'
const DEFAULT_TESTNET_HOST = 'https://staging-messagebox.babbage.systems'

interface AdvertisementToken {
  host: string
  txid: HexString
  outputIndex: number
  lockingScript: LockingScript
  beef: BEEF
}

/**
 * @class MessageBoxClient
 * @description
 * A secure client for sending and receiving authenticated, encrypted messages
 * through a MessageBox server over HTTP and WebSocket.
 *
 * Core Features:
 * - Identity-authenticated message transport (BRC-2)
 * - AES-256-GCM end-to-end encryption with BRC-42/BRC-43 key derivation
 * - HMAC-based message ID generation for deduplication
 * - Live WebSocket messaging with room-based subscription management
 * - Overlay network discovery and host advertisement broadcasting (SHIP protocol)
 * - Fallback to HTTP messaging when WebSocket is unavailable
 *
 * **Important:**
 * The MessageBoxClient automatically calls `await init()` if needed.
 * Manual initialization is optional but still supported.
 *
 * You may call `await init()` manually for explicit control, but you can also use methods
 * like `sendMessage()` or `listenForLiveMessages()` directly — the client will initialize itself
 * automatically if not yet ready.
 *
 * @example
 * const client = new MessageBoxClient({ walletClient, enableLogging: true })
 * await client.init() // <- Required before using the client
 * await client.sendMessage({ recipient, messageBox: 'payment_inbox', body: 'Hello world' })
 */
export class MessageBoxClient {
  private host: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletClient
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string
  private readonly joinedRooms: Set<string> = new Set()
  private readonly lookupResolver: LookupResolver
  private readonly networkPreset: 'local' | 'mainnet' | 'testnet'
  private initialized = false

  /**
   * @constructor
   * @param {Object} options - Initialization options for the MessageBoxClient.
   * @param {string} [options.host] - The base URL of the MessageBox server. If omitted, defaults to mainnet/testnet hosts.
   * @param {WalletClient} options.walletClient - Wallet instance used for authentication, signing, and encryption.
   * @param {boolean} [options.enableLogging=false] - Whether to enable detailed debug logging to the console.
   * @param {'local' | 'mainnet' | 'testnet'} [options.networkPreset='mainnet'] - Overlay network preset used for routing and advertisement lookup.
   *
   * @description
   * Constructs a new MessageBoxClient.
   *
   * **Note:**
   * Passing a `host` during construction sets the default server.
   * If you do not manually call `await init()`, the client will automatically initialize itself on first use.
   *
   * @example
   * const client = new MessageBoxClient({
   *   host: 'https://messagebox.example',
   *   walletClient,
   *   enableLogging: true,
   *   networkPreset: 'testnet'
   * })
   * await client.init()
   */
  constructor(options: MessageBoxClientOptions = {}) {
    const {
      host,
      walletClient,
      enableLogging = false,
      networkPreset = 'mainnet'
    } = options

    const defaultHost =
      this.networkPreset === 'testnet'
        ? DEFAULT_TESTNET_HOST
        : DEFAULT_MAINNET_HOST

    this.host = host?.trim() ?? defaultHost

    this.walletClient = walletClient ?? new WalletClient()
    this.authFetch = new AuthFetch(this.walletClient)
    this.networkPreset = networkPreset

    this.lookupResolver = new LookupResolver({
      networkPreset
    })

    if (enableLogging) {
      Logger.enable()
    }
  }

  /**
   * @method init
   * @async
   * @param {string} [targetHost] - Optional host to set or override the default host.
   * @returns {Promise<void>}
   *
   * @description
   * Initializes the MessageBoxClient by setting or anointing a MessageBox host.
   *
   * - If the client was constructed with a host, it uses that unless a different targetHost is provided.
   * - If no prior advertisement exists for the identity key and host, it automatically broadcasts a new advertisement.
   * - After calling init(), the client becomes ready to send, receive, and acknowledge messages.
   *
   * This method can be called manually for explicit control,
   * but will be automatically invoked if omitted.
   * @throws {Error} If no valid host is provided, or anointing fails.
   *
   * @example
   * const client = new MessageBoxClient({ host: 'https://mybox.example', walletClient })
   * await client.init()
   * await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
   */
  async init(targetHost: string = this.host): Promise<void> {
    const normalizedHost = targetHost?.trim()
    if (normalizedHost === '') {
      throw new Error('Cannot anoint host: No valid host provided')
    }

    // Check if this is an override host
    if (normalizedHost !== this.host) {
      this.initialized = false
      this.host = normalizedHost
    }

    if (this.initialized) return

    // 1. Get our identity key
    const identityKey = await this.getIdentityKey()
    // 2. Check for any matching advertisements for the given host
    const [firstAdvertisement] = await this.queryAdvertisements(identityKey, normalizedHost)
    // 3. If none our found, anoint this host
    if (firstAdvertisement == null || firstAdvertisement?.host?.trim() === '' || firstAdvertisement?.host !== normalizedHost) {
      Logger.log('[MB CLIENT] Anointing host:', normalizedHost)
      const { txid } = await this.anointHost(normalizedHost)
      if (txid == null || txid.trim() === '') {
        throw new Error('Failed to anoint host: No transaction ID returned')
      }
    }
    this.initialized = true
  }

  /**
   * @method assertInitialized
   * @private
   * @description
   * Ensures that the MessageBoxClient has completed initialization before performing sensitive operations
   * like sending, receiving, or acknowledging messages.
   *
   * If the client is not yet initialized, it will automatically call `await init()` to complete setup.
   *
   * Used automatically by all public methods that require initialization.
   */
  private async assertInitialized(): Promise<void> {
    if (!this.initialized || this.host == null || this.host.trim() === '') {
      await this.init()
    }
  }

  /**
   * @method getJoinedRooms
   * @returns {Set<string>} A set of currently joined WebSocket room IDs
   * @description
   * Returns a live list of WebSocket rooms the client is subscribed to.
   * Useful for inspecting state or ensuring no duplicates are joined.
   */
  public getJoinedRooms(): Set<string> {
    return this.joinedRooms
  }

  /**
 * @method getIdentityKey
 * @returns {Promise<string>} The identity public key of the user
 * @description
 * Returns the client's identity key, used for signing, encryption, and addressing.
 * If not already loaded, it will fetch and cache it.
 */
  public async getIdentityKey(): Promise<string> {
    if (this.myIdentityKey != null && this.myIdentityKey.trim() !== '') {
      return this.myIdentityKey
    }

    Logger.log('[MB CLIENT] Fetching identity key...')
    try {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
      this.myIdentityKey = keyResult.publicKey
      Logger.log(`[MB CLIENT] Identity key fetched: ${this.myIdentityKey}`)
      return this.myIdentityKey
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to fetch identity key:', error)
      throw new Error('Identity key retrieval failed')
    }
  }

  /**
   * @property testSocket
   * @readonly
   * @returns {AuthSocketClient | undefined} The internal WebSocket client (or undefined if not connected).
   * @description
   * Exposes the underlying Authenticated WebSocket client used for live messaging.
   * This is primarily intended for debugging, test frameworks, or direct inspection.
   *
   * Note: Do not interact with the socket directly unless necessary.
   * Use the provided `sendLiveMessage`, `listenForLiveMessages`, and related methods.
   */
  public get testSocket(): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
   * @method initializeConnection
   * @async
   * @returns {Promise<void>}
   * @description
   * Establishes an authenticated WebSocket connection to the configured MessageBox server.
   * Enables live message streaming via room-based channels tied to identity keys.
   *
   * This method:
   * 1. Retrieves the user’s identity key if not already set
   * 2. Initializes a secure AuthSocketClient WebSocket connection
   * 3. Authenticates the connection using the identity key
   * 4. Waits up to 5 seconds for authentication confirmation
   *
   * If authentication fails or times out, the connection is rejected.
   *
   * @throws {Error} If the identity key is unavailable or authentication fails
   *
   * @example
   * const mb = new MessageBoxClient({ walletClient })
   * await mb.initializeConnection()
   * // WebSocket is now ready for use
   */
  async initializeConnection(): Promise<void> {
    await this.assertInitialized()
    Logger.log('[MB CLIENT] initializeConnection() STARTED')

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      Logger.log('[MB CLIENT] Fetching identity key...')
      try {
        const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
        this.myIdentityKey = keyResult.publicKey
        Logger.log(`[MB CLIENT] Identity key fetched successfully: ${this.myIdentityKey}`)
      } catch (error) {
        Logger.error('[MB CLIENT ERROR] Failed to fetch identity key:', error)
        throw new Error('Identity key retrieval failed')
      }
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      Logger.error('[MB CLIENT ERROR] Identity key is still missing after retrieval!')
      throw new Error('Identity key is missing')
    }

    Logger.log('[MB CLIENT] Setting up WebSocket connection...')

    if (this.socket == null) {
      if (typeof this.host !== 'string' || this.host.trim() === '') {
        throw new Error('Cannot initialize WebSocket: Host is not set')
      }
      this.socket = AuthSocketClient(this.host, { wallet: this.walletClient })

      let identitySent = false
      let authenticated = false

      this.socket.on('connect', () => {
        Logger.log('[MB CLIENT] Connected to WebSocket.')

        if (!identitySent) {
          Logger.log('[MB CLIENT] Sending authentication data:', this.myIdentityKey)
          if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
            Logger.error('[MB CLIENT ERROR] Cannot send authentication: Identity key is missing!')
          } else {
            this.socket?.emit('authenticated', { identityKey: this.myIdentityKey })
            identitySent = true
          }
        }
      })

      // Listen for authentication success from the server
      this.socket.on('authenticationSuccess', (data) => {
        Logger.log(`[MB CLIENT] WebSocket authentication successful: ${JSON.stringify(data)}`)
        authenticated = true
      })

      // Handle authentication failures
      this.socket.on('authenticationFailed', (data) => {
        Logger.error(`[MB CLIENT ERROR] WebSocket authentication failed: ${JSON.stringify(data)}`)
        authenticated = false
      })

      this.socket.on('disconnect', () => {
        Logger.log('[MB CLIENT] Disconnected from MessageBox server')
        this.socket = undefined
        identitySent = false
        authenticated = false
      })

      this.socket.on('error', (error) => {
        Logger.error('[MB CLIENT ERROR] WebSocket error:', error)
      })

      // Wait for authentication confirmation before proceeding
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (authenticated) {
            Logger.log('[MB CLIENT] WebSocket fully authenticated and ready!')
            resolve()
          } else {
            reject(new Error('[MB CLIENT ERROR] WebSocket authentication timed out!'))
          }
        }, 5000) // Timeout after 5 seconds
      })
    }
  }

  /**
   * @method resolveHostForRecipient
   * @async
   * @param {string} identityKey - The public identity key of the intended recipient.
   * @returns {Promise<string>} - A fully qualified host URL for the recipient's MessageBox server.
   *
   * @description
   * Attempts to resolve the most recently anointed MessageBox host for the given identity key
   * using the BSV overlay network and the `ls_messagebox` LookupResolver.
   *
   * If no advertisements are found, or if resolution fails, the client will fall back
   * to its own configured `host`. This allows seamless operation in both overlay and non-overlay environments.
   *
   * This method guarantees a non-null return value and should be used directly when routing messages.
   *
   * @example
   * const host = await resolveHostForRecipient('028d...') // → returns either overlay host or this.host
   */
  async resolveHostForRecipient(identityKey: string): Promise<string> {
    const advertisementTokens = await this.queryAdvertisements(identityKey)
    if (advertisementTokens.length === 0) {
      Logger.warn(`[MB CLIENT] No advertisements for ${identityKey}, using default host ${this.host}`)
      return this.host
    }
    // Return the first host found
    return advertisementTokens[0].host
  }

  /**
   * Core lookup: ask the LookupResolver (optionally filtered by host),
   * decode every PushDrop output, and collect all the host URLs you find.
   *
   * @param identityKey  the recipient’s public key
   * @param host?        if passed, only look for adverts anointed at that host
   * @returns            0-length array if nothing valid was found
   */
  async queryAdvertisements(
    identityKey?: string,
    host?: string
  ): Promise<AdvertisementToken[]> {
    const hosts: AdvertisementToken[] = []
    try {
      const query: Record<string, string> = { identityKey: identityKey ?? await this.getIdentityKey() }
      if (host != null && host.trim() !== '') query.host = host

      const result = await this.lookupResolver.query({
        service: 'ls_messagebox',
        query
      })
      if (result.type !== 'output-list') {
        throw new Error(`Unexpected result type: ${result.type}`)
      }

      for (const output of result.outputs) {
        try {
          const tx = Transaction.fromBEEF(output.beef)
          const script = tx.outputs[output.outputIndex].lockingScript
          const token = PushDrop.decode(script)
          const [, hostBuf] = token.fields

          if (hostBuf == null || hostBuf.length === 0) {
            throw new Error('Empty host field')
          }

          hosts.push({
            host: Utils.toUTF8(hostBuf),
            txid: tx.id('hex'),
            outputIndex: output.outputIndex,
            lockingScript: script,
            beef: output.beef
          })
        } catch {
          // skip any malformed / non-PushDrop outputs
        }
      }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] _queryAdvertisements failed:', err)
    }
    return hosts
  }

  /**
   * @method joinRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to join (e.g., "payment_inbox").
   * @returns {Promise<void>}
   *
   * @description
   * Joins a WebSocket room that corresponds to the user’s identity key and the specified message box.
   * This is required to receive real-time messages via WebSocket for a specific type of communication.
   *
   * If the WebSocket connection is not already established, this method will first initialize the connection.
   * It also ensures the room is only joined once, and tracks all joined rooms in an internal set.
   *
   * Room ID format: `${identityKey}-${messageBox}`
   *
   * @example
   * await client.joinRoom('payment_inbox')
   * // Now listening for real-time messages in room '028d...-payment_inbox'
   */
  async joinRoom(messageBox: string): Promise<void> {
    await this.assertInitialized()
    Logger.log(`[MB CLIENT] Attempting to join WebSocket room: ${messageBox}`)

    // Ensure WebSocket connection is established first
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No WebSocket connection. Initializing...')
      await this.initializeConnection()
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey ?? ''}-${messageBox}`

    if (this.joinedRooms.has(roomId)) {
      Logger.log(`[MB CLIENT] Already joined WebSocket room: ${roomId}`)
      return
    }

    try {
      Logger.log(`[MB CLIENT] Joining WebSocket room: ${roomId}`)
      await this.socket?.emit('joinRoom', roomId)
      this.joinedRooms.add(roomId)
      Logger.log(`[MB CLIENT] Successfully joined room: ${roomId}`)
    } catch (error) {
      Logger.error(`[MB CLIENT ERROR] Failed to join WebSocket room: ${roomId}`, error)
    }
  }

  /**
   * @method listenForLiveMessages
   * @async
   * @param {Object} params - Configuration for the live message listener.
   * @param {function} params.onMessage - A callback function that will be triggered when a new message arrives.
   * @param {string} params.messageBox - The messageBox name (e.g., `payment_inbox`) to listen for.
   * @returns {Promise<void>}
   *
   * @description
   * Subscribes the client to live messages over WebSocket for a specific messageBox.
   *
   * This method:
   * - Ensures the WebSocket connection is initialized and authenticated.
   * - Joins the correct room formatted as `${identityKey}-${messageBox}`.
   * - Listens for messages broadcast to the room.
   * - Automatically attempts to parse and decrypt message bodies.
   * - Emits the final message (as a `PeerMessage`) to the supplied `onMessage` handler.
   *
   * If the incoming message is encrypted, the client decrypts it using AES-256-GCM via
   * ECDH shared secrets derived from identity keys as defined in [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md).
   * Messages sent by the client to itself are decrypted using `counterparty = 'self'`.
   *
   * @example
   * await client.listenForLiveMessages({
   *   messageBox: 'payment_inbox',
   *   onMessage: (msg) => console.log('Received live message:', msg)
   * })
   */
  async listenForLiveMessages({
    onMessage,
    messageBox
  }: {
    onMessage: (message: PeerMessage) => void
    messageBox: string
  }): Promise<void> {
    await this.assertInitialized()
    Logger.log(`[MB CLIENT] Setting up listener for WebSocket room: ${messageBox}`)

    // Ensure WebSocket connection and room join
    await this.joinRoom(messageBox)

    // Ensure identity key is available before creating roomId
    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is missing. Cannot construct room ID.')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`

    Logger.log(`[MB CLIENT] Listening for messages in room: ${roomId}`)

    this.socket?.on(`sendMessage-${roomId}`, (message: PeerMessage) => {
      void (async () => {
        Logger.log(`[MB CLIENT] Received message in room ${roomId}:`, message)

        try {
          let parsedBody: unknown = message.body

          if (typeof parsedBody === 'string') {
            try {
              parsedBody = JSON.parse(parsedBody)
            } catch {
              // Leave it as-is (plain text)
            }
          }

          if (
            parsedBody != null &&
            typeof parsedBody === 'object' &&
            typeof (parsedBody as any).encryptedMessage === 'string'
          ) {
            Logger.log(`[MB CLIENT] Decrypting message from ${String(message.sender)}...`)
            const decrypted = await this.walletClient.decrypt({
              protocolID: [1, 'messagebox'],
              keyID: '1',
              counterparty: message.sender,
              ciphertext: Utils.toArray((parsedBody as any).encryptedMessage, 'base64')
            })

            message.body = Utils.toUTF8(decrypted.plaintext)
          } else {
            Logger.log('[MB CLIENT] Message is not encrypted.')
            message.body = typeof parsedBody === 'string'
              ? parsedBody
              : (() => { try { return JSON.stringify(parsedBody) } catch { return '[Error: Unstringifiable message]' } })()
          }
        } catch (err) {
          Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt live message:', err)
          message.body = '[Error: Failed to decrypt or parse message]'
        }

        onMessage(message)
      })()
    })
  }

  /**
   * @method sendLiveMessage
   * @async
   * @param {SendMessageParams} param0 - The message parameters including recipient, box name, body, and options.
   * @returns {Promise<SendMessageResponse>} A success response with the generated messageId.
   *
   * @description
   * Sends a message in real time using WebSocket with authenticated delivery and overlay fallback.
   *
   * This method:
   * - Ensures the WebSocket connection is open and joins the correct room.
   * - Derives a unique message ID using an HMAC of the message body and counterparty identity key.
   * - Encrypts the message body using AES-256-GCM based on the ECDH shared secret between derived keys, per [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md),
   *   unless `skipEncryption` is explicitly set to `true`.
   * - Sends the message to a WebSocket room in the format `${recipient}-${messageBox}`.
   * - Waits for acknowledgment (`sendMessageAck-${roomId}`).
   * - If no acknowledgment is received within 10 seconds, falls back to `sendMessage()` over HTTP.
   *
   * This hybrid delivery strategy ensures reliability in both real-time and offline-capable environments.
   *
   * @throws {Error} If message validation fails, HMAC generation fails, or both WebSocket and HTTP fail to deliver.
   *
   * @example
   * await client.sendLiveMessage({
   *   recipient: '028d...',
   *   messageBox: 'payment_inbox',
   *   body: { amount: 1000 }
   * })
   */
  async sendLiveMessage({
    recipient,
    messageBox,
    body,
    messageId,
    skipEncryption
  }: SendMessageParams): Promise<SendMessageResponse> {
    await this.assertInitialized()
    if (recipient == null || recipient.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Recipient identity key is required')
    }
    if (messageBox == null || messageBox.trim() === '') {
      throw new Error('[MB CLIENT ERROR] MessageBox is required')
    }
    if (body == null || (typeof body === 'string' && body.trim() === '')) {
      throw new Error('[MB CLIENT ERROR] Message body cannot be empty')
    }

    // Ensure room is joined before sending
    await this.joinRoom(messageBox)

    // Fallback to HTTP if WebSocket is not connected
    if (this.socket == null || !this.socket.connected) {
      Logger.warn('[MB CLIENT WARNING] WebSocket not connected, falling back to HTTP')
      const targetHost = await this.resolveHostForRecipient(recipient)
      return await this.sendMessage({ recipient, messageBox, body }, targetHost)
    }

    let finalMessageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: recipient
      })
      finalMessageId = messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    const roomId = `${recipient}-${messageBox}`
    Logger.log(`[MB CLIENT] Sending WebSocket message to room: ${roomId}`)

    let outgoingBody: string
    if (skipEncryption === true) {
      outgoingBody = typeof body === 'string' ? body : JSON.stringify(body)
    } else {
      const encryptedMessage = await this.walletClient.encrypt({
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: recipient,
        plaintext: Utils.toArray(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
      })

      outgoingBody = JSON.stringify({
        encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext)
      })
    }

    return await new Promise((resolve, reject) => {
      const ackEvent = `sendMessageAck-${roomId}`
      let handled = false

      const ackHandler = (response?: SendMessageResponse): void => {
        if (handled) return
        handled = true

        const socketAny = this.socket as any
        if (typeof socketAny?.off === 'function') {
          socketAny.off(ackEvent, ackHandler)
        }

        Logger.log('[MB CLIENT] Received WebSocket acknowledgment:', response)

        if (response == null || response.status !== 'success') {
          Logger.warn('[MB CLIENT] WebSocket message failed or returned unexpected response. Falling back to HTTP.')
          const fallbackMessage: SendMessageParams = {
            recipient,
            messageBox,
            body,
            messageId: finalMessageId,
            skipEncryption
          }

          this.resolveHostForRecipient(recipient)
            .then(async (host) => {
              return await this.sendMessage(fallbackMessage, host)
            })
            .then(resolve)
            .catch(reject)
        } else {
          Logger.log('[MB CLIENT] Message sent successfully via WebSocket:', response)
          resolve(response)
        }
      }

      // Attach acknowledgment listener
      this.socket?.on(ackEvent, ackHandler)

      // Emit message to room
      this.socket?.emit('sendMessage', {
        roomId,
        message: {
          messageId: finalMessageId,
          recipient,
          body: outgoingBody
        }
      })

      // Timeout: Fallback to HTTP if no acknowledgment received
      setTimeout(() => {
        if (!handled) {
          handled = true
          const socketAny = this.socket as any
          if (typeof socketAny?.off === 'function') {
            socketAny.off(ackEvent, ackHandler)
          }
          Logger.warn('[CLIENT] WebSocket acknowledgment timed out, falling back to HTTP')
          const fallbackMessage: SendMessageParams = {
            recipient,
            messageBox,
            body,
            messageId: finalMessageId,
            skipEncryption
          }

          this.resolveHostForRecipient(recipient)
            .then(async (host) => {
              return await this.sendMessage(fallbackMessage, host)
            })
            .then(resolve)
            .catch(reject)
        }
      }, 10000)
    })
  }

  /**
   * @method leaveRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to leave (e.g., `payment_inbox`).
   * @returns {Promise<void>}
   *
   * @description
   * Leaves a previously joined WebSocket room associated with the authenticated identity key.
   * This helps reduce unnecessary message traffic and memory usage.
   *
   * If the WebSocket is not connected or the identity key is missing, the method exits gracefully.
   *
   * @example
   * await client.leaveRoom('payment_inbox')
   */
  async leaveRoom(messageBox: string): Promise<void> {
    await this.assertInitialized()
    if (this.socket == null) {
      Logger.warn('[MB CLIENT] Attempted to leave a room but WebSocket is not connected.')
      return
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`
    Logger.log(`[MB CLIENT] Leaving WebSocket room: ${roomId}`)
    this.socket.emit('leaveRoom', roomId)

    // Ensure the room is removed from tracking
    this.joinedRooms.delete(roomId)
  }

  /**
   * @method disconnectWebSocket
   * @async
   * @returns {Promise<void>} Resolves when the WebSocket connection is successfully closed.
   *
   * @description
   * Gracefully disconnects the WebSocket connection to the MessageBox server.
   * This should be called when the client is shutting down, logging out, or no longer
   * needs real-time communication to conserve system resources.
   *
   * @example
   * await client.disconnectWebSocket()
   */
  async disconnectWebSocket(): Promise<void> {
    await this.assertInitialized()
    if (this.socket != null) {
      Logger.log('[MB CLIENT] Closing WebSocket connection...')
      this.socket.disconnect()
      this.socket = undefined
    } else {
      Logger.log('[MB CLIENT] No active WebSocket connection to close.')
    }
  }

  /**
   * @method sendMessage
   * @async
   * @param {SendMessageParams} message - Contains recipient, messageBox name, message body, optional messageId, and skipEncryption flag.
   * @param {string} [overrideHost] - Optional host to override overlay resolution (useful for testing or private routing).
   * @returns {Promise<SendMessageResponse>} - Resolves with `{ status, messageId }` on success.
   *
   * @description
   * Sends a message over HTTP to a recipient's messageBox. This method:
   *
   * - Derives a deterministic `messageId` using an HMAC of the message body and recipient key.
   * - Encrypts the message body using AES-256-GCM, derived from a shared secret using BRC-2-compliant key derivation and ECDH, unless `skipEncryption` is set to true.
   * - Automatically resolves the host via overlay LookupResolver unless an override is provided.
   * - Authenticates the request using the current identity key with `AuthFetch`.
   *
   * This is the fallback mechanism for `sendLiveMessage` when WebSocket delivery fails.
   * It is also used for message types that do not require real-time delivery.
   *
   * @throws {Error} If validation, encryption, HMAC, or network request fails.
   *
   * @example
   * await client.sendMessage({
   *   recipient: '03abc...',
   *   messageBox: 'notifications',
   *   body: { type: 'ping' }
   * })
   */
  async sendMessage(
    message: SendMessageParams,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
    await this.assertInitialized()
    if (message.recipient == null || message.recipient.trim() === '') {
      throw new Error('You must provide a message recipient!')
    }
    if (message.messageBox == null || message.messageBox.trim() === '') {
      throw new Error('You must provide a messageBox to send this message into!')
    }
    if (message.body == null || (typeof message.body === 'string' && message.body.trim().length === 0)) {
      throw new Error('Every message must have a body!')
    }

    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient
      })
      messageId = message.messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    let finalBody: string | EncryptedMessage
    if (message.skipEncryption === true) {
      finalBody = typeof message.body === 'string' ? message.body : JSON.stringify(message.body)
    } else {
      const encryptedMessage = await this.walletClient.encrypt({
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient,
        plaintext: Utils.toArray(typeof message.body === 'string' ? message.body : JSON.stringify(message.body), 'utf8')
      })

      finalBody = JSON.stringify({ encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext) })
    }

    const requestBody = {
      message: {
        ...message,
        messageId,
        body: finalBody
      }
    }

    try {
      const finalHost = overrideHost ?? await this.resolveHostForRecipient(message.recipient)

      Logger.log('[MB CLIENT] Sending HTTP request to:', `${finalHost}/sendMessage`)
      Logger.log('[MB CLIENT] Request Body:', JSON.stringify(requestBody, null, 2))

      if (this.myIdentityKey == null || this.myIdentityKey === '') {
        try {
          const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
          this.myIdentityKey = keyResult.publicKey
          Logger.log(`[MB CLIENT] Fetched identity key before sending request: ${this.myIdentityKey}`)
        } catch (error) {
          Logger.error('[MB CLIENT ERROR] Failed to fetch identity key:', error)
          throw new Error('Identity key retrieval failed')
        }
      }

      const response = await this.authFetch.fetch(`${finalHost}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })

      if (response.bodyUsed) {
        throw new Error('[MB CLIENT ERROR] Response body has already been used!')
      }

      const parsedResponse = await response.json()
      Logger.log('[MB CLIENT] Raw Response Body:', parsedResponse)

      if (!response.ok) {
        Logger.error(`[MB CLIENT ERROR] Failed to send message. HTTP ${response.status}: ${response.statusText}`)
        throw new Error(`Message sending failed: HTTP ${response.status} - ${response.statusText}`)
      }

      if (parsedResponse.status !== 'success') {
        Logger.error(`[MB CLIENT ERROR] Server returned an error: ${String(parsedResponse.description)}`)
        throw new Error(parsedResponse.description ?? 'Unknown error from server.')
      }

      Logger.log('[MB CLIENT] Message successfully sent.')
      return { ...parsedResponse, messageId }
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Network or timeout error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to send message: ${errorMessage}`)
    }
  }

  /**
   * @method anointHost
   * @async
   * @param {string} host - The full URL of the server you want to designate as your MessageBox host (e.g., "https://mybox.com").
   * @returns {Promise<{ txid: string }>} - The transaction ID of the advertisement broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed overlay advertisement using a PushDrop output under the `tm_messagebox` topic.
   * This advertisement announces that the specified `host` is now authorized to receive and route
   * messages for the sender’s identity key.
   *
   * The broadcasted message includes:
   * - The identity key
   * - The chosen host URL
   *
   * This is essential for enabling overlay-based message delivery via SHIP and LookupResolver.
   * The recipient’s host must advertise itself for message routing to succeed in a decentralized manner.
   *
   * @throws {Error} If the URL is invalid, the PushDrop creation fails, or the overlay broadcast does not succeed.
   *
   * @example
   * const { txid } = await client.anointHost('https://my-messagebox.io')
   */
  async anointHost(host: string): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting anointHost...')
    try {
      if (!host.startsWith('http')) {
        throw new Error('Invalid host URL')
      }

      const identityKey = await this.getIdentityKey()

      Logger.log('[MB CLIENT] Fields - Identity:', identityKey, 'Host:', host)

      const fields: number[][] = [
        Utils.toArray(identityKey, 'hex'),
        Utils.toArray(host, 'utf8')
      ]

      const pushdrop = new PushDrop(this.walletClient)
      Logger.log('Fields:', fields.map(a => Utils.toHex(a)))
      Logger.log('ProtocolID:', [1, 'messagebox advertisement'])
      Logger.log('KeyID:', '1')
      Logger.log('SignAs:', 'self')
      Logger.log('anyoneCanSpend:', false)
      Logger.log('forSelf:', true)
      const script = await pushdrop.lock(
        fields,
        [1, 'messagebox advertisement'],
        '1',
        'anyone',
        true
      )

      Logger.log('[MB CLIENT] PushDrop script:', script.toASM())

      const { tx, txid } = await this.walletClient.createAction({
        description: 'Anoint host for overlay routing',
        outputs: [{
          basket: 'overlay advertisements',
          lockingScript: script.toHex(),
          satoshis: 1,
          outputDescription: 'Overlay advertisement output'
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })

      Logger.log('[MB CLIENT] Transaction created:', txid)

      if (tx !== undefined) {
        const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
          networkPreset: this.networkPreset
        })

        const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(tx))
        Logger.log('[MB CLIENT] Advertisement broadcast succeeded. TXID:', result.txid)

        if (typeof result.txid !== 'string') {
          throw new Error('Anoint failed: broadcast did not return a txid')
        }

        return { txid: result.txid }
      }

      throw new Error('Anoint failed: failed to create action!')
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] anointHost threw:', err)
      throw err
    }
  }

  /**
   * @method revokeHostAdvertisement
   * @async
   * @param {AdvertisementToken} advertisementToken - The advertisement token containing the messagebox host to revoke.
   * @returns {Promise<{ txid: string }>} - The transaction ID of the revocation broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed revocation transaction indicating the advertisement token should be removed
   * and no longer tracked by lookup services.
   *
   * @example
   * const { txid } = await client.revokeHost('https://my-messagebox.io')
   */
  async revokeHostAdvertisement(advertisementToken: AdvertisementToken): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting revokeHost...')
    const outpoint = `${advertisementToken.txid}.${advertisementToken.outputIndex}`
    try {
      const { signableTransaction } = await this.walletClient.createAction({
        description: 'Revoke MessageBox host advertisement',
        inputBEEF: advertisementToken.beef,
        inputs: [
          {
            outpoint,
            unlockingScriptLength: 73,
            inputDescription: 'Revoking host advertisement token'
          }
        ]
      })

      if (signableTransaction === undefined) {
        throw new Error('Failed to create signable transaction.')
      }

      const partialTx = Transaction.fromBEEF(signableTransaction.tx)

      // Prepare the unlocker
      const pushdrop = new PushDrop(this.walletClient)
      const unlocker = await pushdrop.unlock(
        [1, 'messagebox advertisement'],
        '1',
        'anyone',
        'all',
        false,
        advertisementToken.outputIndex,
        advertisementToken.lockingScript
      )

      // Convert to Transaction, apply signature
      const finalUnlockScript = await unlocker.sign(partialTx, advertisementToken.outputIndex)

      // Complete signing with the final unlock script
      const { tx: signedTx } = await this.walletClient.signAction({
        reference: signableTransaction.reference,
        spends: {
          [advertisementToken.outputIndex]: {
            unlockingScript: finalUnlockScript.toHex()
          }
        },
        options: {
          acceptDelayedBroadcast: false
        }
      })

      if (signedTx === undefined) {
        throw new Error('Failed to finalize the transaction signature.')
      }

      const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
        networkPreset: this.networkPreset
      })

      const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
      Logger.log('[MB CLIENT] Revocation broadcast succeeded. TXID:', result.txid)

      if (typeof result.txid !== 'string') {
        throw new Error('Revoke failed: broadcast did not return a txid')
      }

      return { txid: result.txid }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] revokeHost threw:', err)
      throw err
    }
  }

  /**
   * @method listMessages
   * @async
   * @param {ListMessagesParams} params - Contains the name of the messageBox to read from.
   * @returns {Promise<PeerMessage[]>} - Returns an array of decrypted `PeerMessage` objects.
   *
   * @description
   * Retrieves all messages from the specified `messageBox` assigned to the current identity key.
   * Unless a host override is provided, messages are fetched from the resolved overlay host (via LookupResolver) or the default host if no advertisement is found.
   *
   * Each message is:
   * - Parsed and, if encrypted, decrypted using AES-256-GCM via BRC-2-compliant ECDH key derivation and symmetric encryption.
   * - Returned as a normalized `PeerMessage` with readable string body content.
   *
   * Decryption automatically derives a shared secret using the sender’s identity key and the receiver’s child private key.
   * If the sender is the same as the recipient, the `counterparty` is set to `'self'`.
   *
   * @throws {Error} If no messageBox is specified, the request fails, or the server returns an error.
   *
   * @example
   * const messages = await client.listMessages({ messageBox: 'inbox' })
   * messages.forEach(msg => console.log(msg.sender, msg.body))
   */
  async listMessages({ messageBox, host }: ListMessagesParams): Promise<PeerMessage[]> {
    await this.assertInitialized()
    if (messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      const advertisedHosts = await this.queryAdvertisements(await this.getIdentityKey())
      hosts = Array.from(new Set([this.host, ...advertisedHosts.map(h => h.host)]))
    }

    // Query each host in parallel
    const fetchFromHost = async (host: string): Promise<PeerMessage[]> => {
      try {
        Logger.log(`[MB CLIENT] Listing messages from ${host}…`)
        const res = await this.authFetch.fetch(`${host}/listMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageBox })
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const data = await res.json()
        if (data.status === 'error') throw new Error(data.description ?? 'Unknown server error')
        return data.messages as PeerMessage[]
      } catch (err) {
        Logger.log(`[MB CLIENT DEBUG] listMessages failed for ${host}:`, err)
        throw err // re-throw to be caught in the settled promise
      }
    }

    const settled = await Promise.allSettled(hosts.map(fetchFromHost))

    // 3. Split successes / failures
    const messagesByHost: PeerMessage[][] = []
    const errors: any[] = []

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        messagesByHost.push(r.value)
      } else {
        errors.push(r.reason)
      }
    }

    // 4. If *every* host failed – throw aggregated error
    if (messagesByHost.length === 0) {
      throw new Error('Failed to retrieve messages from any host')
    }

    // 5. Merge & de‑duplicate (first‑seen wins)
    const dedupMap = new Map<string, PeerMessage>()
    for (const messageList of messagesByHost) {
      for (const m of messageList) {
        if (!dedupMap.has(m.messageId)) dedupMap.set(m.messageId, m)
      }
    }

    // 6. Early‑out: no messages but at least one host succeeded → []
    if (dedupMap.size === 0) return []

    const tryParse = (raw: string): any => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }

    const messages: PeerMessage[] = Array.from(dedupMap.values())

    for (const message of messages) {
      try {
        const parsedBody: unknown =
          typeof message.body === 'string' ? tryParse(message.body) : message.body

        if (
          parsedBody != null &&
          typeof parsedBody === 'object' &&
          typeof (parsedBody as any).encryptedMessage === 'string'
        ) {
          Logger.log(
            `[MB CLIENT] Decrypting message from ${String(message.sender)}…`
          )

          const decrypted = await this.walletClient.decrypt({
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: message.sender,
            ciphertext: Utils.toArray(
              (parsedBody as any).encryptedMessage,
              'base64'
            )
          })

          const decryptedText = Utils.toUTF8(decrypted.plaintext)
          message.body = tryParse(decryptedText)
        } else {
          message.body = parsedBody as string | Record<string, any>
        }
      } catch (err) {
        Logger.error(
          '[MB CLIENT ERROR] Failed to parse or decrypt message in list:',
          err
        )
        message.body = '[Error: Failed to decrypt or parse message]'
      }
    }

    // Sort newest‑first for a deterministic order
    messages.sort(
      (a, b) =>
        Number((b as any).timestamp ?? 0) - Number((a as any).timestamp ?? 0)
    )

    return messages
  }

  /**
   * @method acknowledgeMessage
   * @async
   * @param {AcknowledgeMessageParams} params - An object containing an array of message IDs to acknowledge.
   * @returns {Promise<string>} - A string indicating the result, typically `'success'`.
   *
   * @description
   * Notifies the MessageBox server(s) that one or more messages have been
   * successfully received and processed by the client. Once acknowledged, these messages are removed
   * from the recipient's inbox on the server(s).
   *
   * This operation is essential for proper message lifecycle management and prevents duplicate
   * processing or delivery.
   *
   * Acknowledgment supports providing a host override, or will use overlay routing to find the appropriate server the received the given message.
   *
   * @throws {Error} If the message ID array is missing or empty, or if the request to the server fails.
   *
   * @example
   * await client.acknowledgeMessage({ messageIds: ['msg123', 'msg456'] })
   */
  async acknowledgeMessage({ messageIds, host }: AcknowledgeMessageParams): Promise<string> {
    await this.assertInitialized()
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('Message IDs array cannot be empty')
    }

    Logger.log(`[MB CLIENT] Acknowledging messages ${JSON.stringify(messageIds)}…`)

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      // 1. Determine all hosts (advertised + default)
      const identityKey = await this.getIdentityKey()
      const advertisedHosts = await this.queryAdvertisements(identityKey)
      hosts = Array.from(new Set([this.host, ...advertisedHosts.map(h => h.host)]))
    }

    // 2. Dispatch parallel acknowledge requests
    const ackFromHost = async (host: string): Promise<string | null> => {
      try {
        const res = await this.authFetch.fetch(`${host}/acknowledgeMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds })
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.status === 'error') throw new Error(data.description)
        Logger.log(`[MB CLIENT] Acknowledged on ${host}`)
        return data.status as string
      } catch (err) {
        Logger.warn(`[MB CLIENT WARN] acknowledgeMessage failed for ${host}:`, err)
        return null
      }
    }

    const settled = await Promise.allSettled(hosts.map(ackFromHost))

    const successes = settled.filter(
      (r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled'
    )

    const firstSuccess = successes.find(s => s.value != null)?.value

    if (firstSuccess != null) {
      return firstSuccess
    }

    // No host accepted the acknowledgement
    const errs: any[] = []
    for (const r of settled) {
      if (r.status === 'rejected') errs.push(r.reason)
    }
    throw new Error(
      `Failed to acknowledge messages on all hosts: ${errs.map(e => String(e)).join('; ')}`
    )
  }
}
