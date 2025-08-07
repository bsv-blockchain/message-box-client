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
  PubKeyHex,
  P2PKH,
  PublicKey,
  CreateActionOutput,
  WalletInterface,
  ProtoWallet,
  InternalizeOutput,
  Random
} from '@bsv/sdk'
import { AuthSocketClient } from '@bsv/authsocket-client'
import * as Logger from './Utils/logger.js'
import { AcknowledgeMessageParams, AdvertisementToken, EncryptedMessage, ListMessagesParams, MessageBoxClientOptions, Payment, PeerMessage, SendMessageParams, SendMessageResponse, DeviceRegistrationParams, DeviceRegistrationResponse, RegisteredDevice, ListDevicesResponse } from './types.js'
import {
  SetMessageBoxPermissionParams,
  GetMessageBoxPermissionParams,
  MessageBoxPermission,
  MessageBoxQuote,
  ListPermissionsParams,
  GetQuoteParams
} from './types/permissions.js'

const DEFAULT_MAINNET_HOST = 'https://messagebox.babbage.systems'
const DEFAULT_TESTNET_HOST = 'https://staging-messagebox.babbage.systems'

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
  private readonly walletClient: WalletInterface
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
   * @param {WalletInterface} options.walletClient - Wallet instance used for authentication, signing, and encryption.
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
      networkPreset = 'mainnet',
      originator = undefined
    } = options

    const defaultHost =
      this.networkPreset === 'testnet'
        ? DEFAULT_TESTNET_HOST
        : DEFAULT_MAINNET_HOST

    this.host = host?.trim() ?? defaultHost

    this.walletClient = walletClient ?? new WalletClient('auto', originator)
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
   * @param {string} [originator] - Optional originator to use with walletClient.
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
  async init(targetHost: string = this.host, originator?: string): Promise<void> {
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
    const identityKey = await this.getIdentityKey(originator)
    // 2. Check for any matching advertisements for the given host
    const [firstAdvertisement] = await this.queryAdvertisements(identityKey, normalizedHost, originator)
    // 3. If none our found, anoint this host
    if (firstAdvertisement == null || firstAdvertisement?.host?.trim() === '' || firstAdvertisement?.host !== normalizedHost) {
      Logger.log('[MB CLIENT] Anointing host:', normalizedHost)
      const { txid } = await this.anointHost(normalizedHost, originator)
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
 * @param {string} [originator] - Optional originator to use for identity key lookup
 * @returns {Promise<string>} The identity public key of the user
 * @description
 * Returns the client's identity key, used for signing, encryption, and addressing.
 * If not already loaded, it will fetch and cache it.
 */
  public async getIdentityKey(originator?: string): Promise<string> {
    if (this.myIdentityKey != null && this.myIdentityKey.trim() !== '') {
      return this.myIdentityKey
    }

    Logger.log('[MB CLIENT] Fetching identity key...')
    try {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true }, originator)
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
   * @param {string} [originator] - Optional originator to use for authentication.
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
  async initializeConnection(originator?: string): Promise<void> {
    await this.assertInitialized()
    Logger.log('[MB CLIENT] initializeConnection() STARTED')

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      await this.getIdentityKey(originator)
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
   * @param {string} [originator] - The originator to use for the WalletClient.
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
  async resolveHostForRecipient(identityKey: string, originator?: string): Promise<string> {
    const advertisementTokens = await this.queryAdvertisements(identityKey, undefined, originator)
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
    host?: string,
    originator?: string
  ): Promise<AdvertisementToken[]> {
    const hosts: AdvertisementToken[] = []
    try {
      const query: Record<string, string> = { identityKey: identityKey ?? await this.getIdentityKey(originator) }
      if (host != null && host.trim() !== '') query.host = host

      const result = await this.lookupResolver.query({
        service: 'ls_messagebox',
        query
      })
      if (result.type !== 'output-list') {
        throw new Error(`Unexpected result type: ${String(result.type)}`)
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
    messageBox,
    originator
  }: {
    onMessage: (message: PeerMessage) => void
    messageBox: string
    originator?: string
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
            }, originator)

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
    skipEncryption,
    checkPermissions,
    originator
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
      }, originator)
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
      }, originator)

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
            skipEncryption,
            checkPermissions
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
            skipEncryption,
            checkPermissions
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
    overrideHost?: string,
    originator?: string
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

    // Optional permission checking for backwards compatibility
    let paymentData: Payment | undefined
    if (message.checkPermissions === true) {
      try {
        Logger.log('[MB CLIENT] Checking permissions and fees for message...')

        // Get quote to check if payment is required
        const quote = await this.getMessageBoxQuote({
          recipient: message.recipient,
          messageBox: message.messageBox
        })

        if (quote.recipientFee === -1) {
          throw new Error('You have been blocked from sending messages to this recipient.')
        }

        if (quote.recipientFee > 0 || quote.deliveryFee > 0) {
          const requiredPayment = quote.recipientFee + quote.deliveryFee

          if (requiredPayment > 0) {
            Logger.log(`[MB CLIENT] Creating payment of ${requiredPayment} sats for message...`)

            // Create payment using helper method
            paymentData = await this.createMessagePayment(
              message.recipient,
              quote,
              overrideHost
            )

            Logger.log('[MB CLIENT] Payment data prepared:', paymentData)
          }
        }
      } catch (error) {
        throw new Error(`Permission check failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient
      }, originator)
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
      }, originator)

      finalBody = JSON.stringify({ encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext) })
    }

    const requestBody = {
      message: {
        ...message,
        messageId,
        body: finalBody
      },
      ...(paymentData != null && { payment: paymentData })
    }

    try {
      const finalHost = overrideHost ?? await this.resolveHostForRecipient(message.recipient)

      Logger.log('[MB CLIENT] Sending HTTP request to:', `${finalHost}/sendMessage`)
      Logger.log('[MB CLIENT] Request Body:', JSON.stringify(requestBody, null, 2))

      if (this.myIdentityKey == null || this.myIdentityKey === '') {
        try {
          const keyResult = await this.walletClient.getPublicKey({ identityKey: true }, originator)
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
  async anointHost(host: string, originator?: string): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting anointHost...')
    try {
      if (!host.startsWith('http')) {
        throw new Error('Invalid host URL')
      }

      const identityKey = await this.getIdentityKey(originator)

      Logger.log('[MB CLIENT] Fields - Identity:', identityKey, 'Host:', host)

      const fields: number[][] = [
        Utils.toArray(identityKey, 'hex'),
        Utils.toArray(host, 'utf8')
      ]

      const pushdrop = new PushDrop(this.walletClient, originator)
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
      }, originator)

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
   * @param {string} [originator] - Optional originator to use with walletClient.
   * @returns {Promise<{ txid: string }>} - The transaction ID of the revocation broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed revocation transaction indicating the advertisement token should be removed
   * and no longer tracked by lookup services.
   *
   * @example
   * const { txid } = await client.revokeHost('https://my-messagebox.io')
   */
  async revokeHostAdvertisement(advertisementToken: AdvertisementToken, originator?: string): Promise<{ txid: string }> {
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
      }, originator)

      if (signableTransaction === undefined) {
        throw new Error('Failed to create signable transaction.')
      }

      const partialTx = Transaction.fromBEEF(signableTransaction.tx)

      // Prepare the unlocker
      const pushdrop = new PushDrop(this.walletClient, originator)
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
      }, originator)

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
   * - Automatically processed for payments: if the message includes recipient fee payments, they are internalized using `walletClient.internalizeAction()`.
   * - Returned as a normalized `PeerMessage` with readable string body content.
   *
   * Payment Processing:
   * - Detects messages that include payment data (from paid message delivery).
   * - Automatically internalizes recipient payment outputs, allowing you to receive payments without additional API calls.
   * - Only recipient payments are stored with messages - delivery fees are already processed by the server.
   * - Continues processing messages even if payment internalization fails.
   *
   * Decryption automatically derives a shared secret using the sender's identity key and the receiver's child private key.
   * If the sender is the same as the recipient, the `counterparty` is set to `'self'`.
   *
   * @throws {Error} If no messageBox is specified, the request fails, or the server returns an error.
   *
   * @example
   * const messages = await client.listMessages({ messageBox: 'inbox' })
   * messages.forEach(msg => console.log(msg.sender, msg.body))
   * // Payments included with messages are automatically received
   */
  async listMessages({ messageBox, host, originator }: ListMessagesParams): Promise<PeerMessage[]> {
    await this.assertInitialized()
    if (messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      const advertisedHosts = await this.queryAdvertisements(await this.getIdentityKey(originator), originator)
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

        let messageContent: any = parsedBody
        let paymentData: Payment | undefined

        if (
          parsedBody != null &&
          typeof parsedBody === 'object' &&
          'message' in parsedBody
        ) {
          // Handle wrapped message format (with payment data)
          const wrappedMessage = (parsedBody as any).message
          messageContent = typeof wrappedMessage === 'string'
            ? tryParse(wrappedMessage)
            : wrappedMessage
          paymentData = (parsedBody as any).payment
        }

        // Process payment if present - server now only stores recipient payments
        if (paymentData?.tx != null && paymentData.outputs != null) {
          try {
            Logger.log(
              `[MB CLIENT] Processing recipient payment in message from ${String(message.sender)}…`
            )

            // All outputs in the stored payment data are for the recipient
            // (delivery fees are already processed by the server)
            const recipientOutputs = paymentData.outputs.filter(
              output => output.protocol === 'wallet payment'
            )

            if (recipientOutputs.length > 0) {
              Logger.log(
                `[MB CLIENT] Internalizing ${recipientOutputs.length} recipient payment output(s)…`
              )

              const internalizeResult = await this.walletClient.internalizeAction({
                tx: paymentData.tx,
                outputs: recipientOutputs,
                description: paymentData.description ?? 'MessageBox recipient payment'
              }, originator)

              if (internalizeResult.accepted) {
                Logger.log(
                  '[MB CLIENT] Successfully internalized recipient payment'
                )
              } else {
                Logger.warn(
                  '[MB CLIENT] Recipient payment internalization was not accepted'
                )
              }
            } else {
              Logger.log(
                '[MB CLIENT] No wallet payment outputs found in payment data'
              )
            }
          } catch (paymentError) {
            Logger.error(
              '[MB CLIENT ERROR] Failed to internalize recipient payment:',
              paymentError
            )
            // Continue processing the message even if payment fails
          }
        }

        // Handle message decryption
        if (
          messageContent != null &&
          typeof messageContent === 'object' &&
          typeof (messageContent as any).encryptedMessage === 'string'
        ) {
          Logger.log(
            `[MB CLIENT] Decrypting message from ${String(message.sender)}…`
          )

          const decrypted = await this.walletClient.decrypt({
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: message.sender,
            ciphertext: Utils.toArray(
              messageContent.encryptedMessage,
              'base64'
            )
          }, originator)

          const decryptedText = Utils.toUTF8(decrypted.plaintext)
          message.body = tryParse(decryptedText)
        } else {
          // For non-encrypted messages, use the processed content
          message.body = messageContent ?? parsedBody
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
  async acknowledgeMessage({ messageIds, host, originator }: AcknowledgeMessageParams): Promise<string> {
    await this.assertInitialized()
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('Message IDs array cannot be empty')
    }

    Logger.log(`[MB CLIENT] Acknowledging messages ${JSON.stringify(messageIds)}…`)

    let hosts: string[] = host != null ? [host] : []
    if (hosts.length === 0) {
      // 1. Determine all hosts (advertised + default)
      const identityKey = await this.getIdentityKey(originator)
      const advertisedHosts = await this.queryAdvertisements(identityKey, undefined, originator)
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

  // ===========================
  // PERMISSION MANAGEMENT METHODS
  // ===========================

  /**
   * @method setMessageBoxPermission
   * @async
   * @param {SetMessageBoxPermissionParams} params - Permission configuration
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after setting
   *
   * @description
   * Sets permission for receiving messages in a specific messageBox.
   * Can set sender-specific permissions or box-wide defaults.
   *
   * @example
   * // Set box-wide default: allow notifications for 10 sats
   * await client.setMessageBoxPermission({ messageBox: 'notifications', recipientFee: 10 })
   *
   * // Block specific sender
   * await client.setMessageBoxPermission({
   *   messageBox: 'notifications',
   *   sender: '03abc123...',
   *   recipientFee: -1
   * })
   */
  async setMessageBoxPermission(
    params: SetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<void> {
    await this.assertInitialized()
    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Setting messageBox permission...')

    const response = await this.authFetch.fetch(`${finalHost}/permissions/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBox: params.messageBox,
        recipientFee: params.recipientFee,
        ...(params.sender != null && { sender: params.sender })
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to set permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const { status, description } = await response.json()
    if (status === 'error') {
      throw new Error(description ?? 'Failed to set permission')
    }
  }

  /**
   * @method getMessageBoxPermission
   * @async
   * @param {GetMessageBoxPermissionParams} params - Permission query parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<MessageBoxPermission | null>} Permission data (null if not set)
   *
   * @description
   * Gets current permission data for a sender/messageBox combination.
   * Returns null if no permission is set.
   *
   * @example
   * const status = await client.getMessageBoxPermission({
   *   recipient: '03def456...',
   *   messageBox: 'notifications',
   *   sender: '03abc123...'
   * })
   */
  async getMessageBoxPermission(
    params: GetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<MessageBoxPermission | null> {
    await this.assertInitialized()

    const finalHost = overrideHost ?? await this.resolveHostForRecipient(params.recipient)
    const queryParams = new URLSearchParams({
      recipient: params.recipient,
      messageBox: params.messageBox,
      ...(params.sender != null && { sender: params.sender })
    })

    Logger.log('[MB CLIENT] Getting messageBox permission...')

    const response = await this.authFetch.fetch(`${finalHost}/permissions/get?${queryParams.toString()}`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to get permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to get permission')
    }

    return data.permission
  }

  /**
   * @method getMessageBoxQuote
   * @async
   * @param {GetQuoteParams} params - Quote request parameters
   * @returns {Promise<MessageBoxQuote>} Fee quote and permission status
   *
   * @description
   * Gets a fee quote for sending a message, including delivery and recipient fees.
   *
   * @example
   * const quote = await client.getMessageBoxQuote({
   *   recipient: '03def456...',
   *   messageBox: 'notifications'
   * })
   */
  async getMessageBoxQuote(params: GetQuoteParams, overrideHost?: string): Promise<MessageBoxQuote> {
    await this.assertInitialized()

    const finalHost = overrideHost ?? await this.resolveHostForRecipient(params.recipient)
    const queryParams = new URLSearchParams({
      recipient: params.recipient,
      messageBox: params.messageBox
    })

    Logger.log('[MB CLIENT] Getting messageBox quote...')

    const response = await this.authFetch.fetch(`${finalHost}/permissions/quote?${queryParams.toString()}`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to get quote: HTTP ${response.status} - ${String(errorData.description) ?? response.statusText}`)
    }

    const { status, description, quote } = await response.json()
    if (status === 'error') {
      throw new Error(description ?? 'Failed to get quote')
    }

    const deliveryAgentIdentityKey = response.headers.get('x-bsv-auth-identity-key')

    if (deliveryAgentIdentityKey == null) {
      throw new Error('Failed to get quote: Delivery agent did not provide their identity key')
    }

    return {
      recipientFee: quote.recipientFee,
      deliveryFee: quote.deliveryFee,
      deliveryAgentIdentityKey
    }
  }

  /**
   * @method listMessageBoxPermissions
   * @async
   * @param {ListPermissionsParams} [params] - Optional filtering and pagination parameters
   * @returns {Promise<MessageBoxPermission[]>} List of current permissions
   *
   * @description
   * Lists permissions for the authenticated user's messageBoxes with optional pagination.
   *
   * @example
   * // List all permissions
   * const all = await client.listMessageBoxPermissions()
   *
   * // List only notification permissions with pagination
   * const notifications = await client.listMessageBoxPermissions({
   *   messageBox: 'notifications',
   *   limit: 50,
   *   offset: 0
   * })
   */
  async listMessageBoxPermissions(params?: ListPermissionsParams, overrideHost?: string): Promise<MessageBoxPermission[]> {
    await this.assertInitialized()

    const finalHost = overrideHost ?? this.host
    const queryParams = new URLSearchParams()

    if (params?.messageBox != null) {
      queryParams.set('message_box', params.messageBox)
    }
    if (params?.limit !== undefined) {
      queryParams.set('limit', params.limit.toString())
    }
    if (params?.offset !== undefined) {
      queryParams.set('offset', params.offset.toString())
    }

    Logger.log('[MB CLIENT] Listing messageBox permissions with params:', queryParams.toString())

    const response = await this.authFetch.fetch(`${finalHost}/permissions/list?${queryParams.toString()}`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Failed to list permissions: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to list permissions')
    }

    return data.permissions.map((p: any) => ({
      sender: p.sender,
      messageBox: p.message_box,
      recipientFee: p.recipient_fee,
      status: MessageBoxClient.getStatusFromFee(p.recipient_fee),
      createdAt: p.created_at,
      updatedAt: p.updated_at
    }))
  }

  // ===========================
  // NOTIFICATION CONVENIENCE METHODS
  // ===========================

  /**
   * @method allowNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to allow
   * @param {number} [recipientFee=0] - Fee to charge (0 for always allow)
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after allowing
   *
   * @description
   * Convenience method to allow notifications from a specific peer.
   *
   * @example
   * await client.allowNotificationsFromPeer('03abc123...') // Always allow
   * await client.allowNotificationsFromPeer('03def456...', 5) // Allow for 5 sats
   */
  async allowNotificationsFromPeer(identityKey: PubKeyHex, recipientFee: number = 0, overrideHost?: string): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: 'notifications',
      sender: identityKey,
      recipientFee
    }, overrideHost)
  }

  /**
   * @method denyNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to block
   * @returns {Promise<void>} Permission status after denying
   *
   * @description
   * Convenience method to block notifications from a specific peer.
   *
   * @example
   * await client.denyNotificationsFromPeer('03spam123...')
   */
  async denyNotificationsFromPeer(identityKey: PubKeyHex, overrideHost?: string): Promise<void> {
    await this.setMessageBoxPermission({
      messageBox: 'notifications',
      sender: identityKey,
      recipientFee: -1
    }, overrideHost)
  }

  /**
   * @method checkPeerNotificationStatus
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to check
   * @returns {Promise<MessageBoxPermission>} Current permission status
   *
   * @description
   * Convenience method to check notification permission for a specific peer.
   *
   * @example
   * const status = await client.checkPeerNotificationStatus('03abc123...')
   * console.log(status.allowed) // true/false
   */
  async checkPeerNotificationStatus(identityKey: PubKeyHex, overrideHost?: string): Promise<MessageBoxPermission | null> {
    const myIdentityKey = await this.getIdentityKey()
    return await this.getMessageBoxPermission({
      recipient: myIdentityKey,
      messageBox: 'notifications',
      sender: identityKey
    }, overrideHost)
  }

  /**
   * @method listPeerNotifications
   * @async
   * @returns {Promise<MessageBoxPermission[]>} List of notification permissions
   *
   * @description
   * Convenience method to list all notification permissions.
   *
   * @example
   * const notifications = await client.listPeerNotifications()
   */
  async listPeerNotifications(overrideHost?: string): Promise<MessageBoxPermission[]> {
    return await this.listMessageBoxPermissions({ messageBox: 'notifications' }, overrideHost)
  }

  /**
   * @method sendNotification
   * @async
   * @param {PubKeyHex} recipient - Recipient's identity key
   * @param {string | object} body - Notification content
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<SendMessageResponse>} Send result
   *
   * @description
   * Convenience method to send a notification with automatic quote fetching and payment handling.
   * Automatically determines the required payment amount and creates the payment if needed.
   *
   * @example
   * // Send notification (auto-determines payment needed)
   * await client.sendNotification('03def456...', 'Hello!')
   *
   * // Send with maximum payment limit for safety
   * await client.sendNotification('03def456...', { title: 'Alert', body: 'Important update' }, 50)
   */
  async sendNotification(
    recipient: PubKeyHex,
    body: string | object,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
    await this.assertInitialized()

    // Use sendMessage with permission checking enabled
    // This eliminates duplication of quote fetching and payment logic
    return await this.sendMessage({
      recipient,
      messageBox: 'notifications',
      body,
      checkPermissions: true
    }, overrideHost)
  }

  /**
   * Register a device for FCM push notifications.
   *
   * @async
   * @param {DeviceRegistrationParams} params - Device registration parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<DeviceRegistrationResponse>} Registration response
   *
   * @description
   * Registers a device with the message box server to receive FCM push notifications.
   * The FCM token is obtained from Firebase SDK on the client side.
   *
   * @example
   * const result = await client.registerDevice({
   *   fcmToken: 'eBo8F...',
   *   platform: 'ios',
   *   deviceId: 'iPhone15Pro'
   * })
   */
  async registerDevice(
    params: DeviceRegistrationParams,
    overrideHost?: string
  ): Promise<DeviceRegistrationResponse> {
    await this.assertInitialized()

    if (params.fcmToken == null || params.fcmToken.trim() === '') {
      throw new Error('fcmToken is required and must be a non-empty string')
    }

    // Validate platform if provided
    const validPlatforms = ['ios', 'android', 'web']
    if (params.platform != null && !validPlatforms.includes(params.platform)) {
      throw new Error('platform must be one of: ios, android, web')
    }

    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Registering device for FCM notifications...')

    const response = await this.authFetch.fetch(`${finalHost}/registerDevice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fcmToken: params.fcmToken.trim(),
        deviceId: params.deviceId?.trim() ?? undefined,
        platform: params.platform ?? undefined
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description = String(errorData.description) ?? response.statusText
      throw new Error(`Failed to register device: HTTP ${response.status} - ${description}`)
    }

    const data = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to register device')
    }

    Logger.log('[MB CLIENT] Device registered successfully')
    return {
      status: data.status,
      message: data.message,
      deviceId: data.deviceId
    }
  }

  /**
   * List all registered devices for push notifications.
   *
   * @async
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<RegisteredDevice[]>} Array of registered devices
   *
   * @description
   * Retrieves all devices registered by the authenticated user for FCM push notifications.
   * Only shows devices belonging to the current user (authenticated via AuthFetch).
   *
   * @example
   * const devices = await client.listRegisteredDevices()
   * console.log(`Found ${devices.length} registered devices`)
   * devices.forEach(device => {
   *   console.log(`Device: ${device.platform} - ${device.fcmToken}`)
   * })
   */
  async listRegisteredDevices(
    overrideHost?: string
  ): Promise<RegisteredDevice[]> {
    await this.assertInitialized()

    const finalHost = overrideHost ?? this.host

    Logger.log('[MB CLIENT] Listing registered devices...')

    const response = await this.authFetch.fetch(`${finalHost}/devices`, {
      method: 'GET'
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description = String(errorData.description) ?? response.statusText
      throw new Error(`Failed to list devices: HTTP ${response.status} - ${description}`)
    }

    const data: ListDevicesResponse = await response.json()
    if (data.status === 'error') {
      throw new Error(data.description ?? 'Failed to list devices')
    }

    Logger.log(`[MB CLIENT] Found ${data.devices.length} registered devices`)
    return data.devices
  }

  // ===========================
  // PRIVATE HELPER METHODS
  // ===========================

  private static getStatusFromFee(fee: number): 'always_allow' | 'blocked' | 'payment_required' {
    if (fee === -1) return 'blocked'
    if (fee === 0) return 'always_allow'
    return 'payment_required'
  }

  /**
   * Creates payment transaction for message delivery fees
   * TODO: Consider consolidating payment generating logic with a util PeerPayClient can use as well.
   * @private
   * @param {string} recipient - Recipient identity key
   * @param {MessageBoxQuote} quote - Fee quote with delivery and recipient fees
   * @param {string} description - Description for the payment transaction
   * @returns {Promise<Payment>} Payment transaction data
   */
  private async createMessagePayment(
    recipient: string,
    quote: MessageBoxQuote,
    description: string = 'MessageBox delivery payment',
    originator?: string
  ): Promise<Payment> {
    if (quote.recipientFee <= 0 && quote.deliveryFee <= 0) {
      throw new Error('No payment required')
    }

    Logger.log(`[MB CLIENT] Creating payment transaction for ${quote.recipientFee} sats (delivery: ${quote.deliveryFee}, recipient: ${quote.recipientFee})`)

    const outputs: InternalizeOutput[] = []
    const createActionOutputs: CreateActionOutput[] = []

    // Get sender identity key for remittance data
    const senderIdentityKey = await this.getIdentityKey()

    // Add server delivery fee output if > 0
    let outputIndex = 0
    if (quote.deliveryFee > 0) {
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))

      // Get host's derived public key
      const { publicKey: derivedKeyResult } = await this.walletClient.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: quote.deliveryAgentIdentityKey
      }, originator)

      // Create locking script using host's public key
      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.deliveryFee,
        lockingScript,
        outputDescription: 'MessageBox server delivery fee',
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: quote.deliveryAgentIdentityKey
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey
        }
      })
    }

    // Add recipient fee output if > 0
    if (quote.recipientFee > 0) {
      const derivationPrefix = Utils.toBase64(Random(32))
      const derivationSuffix = Utils.toBase64(Random(32))
      // Get a derived public key for the recipient that "anyone" can verify
      const anyoneWallet = new ProtoWallet('anyone')
      const { publicKey: derivedKeyResult } = await anyoneWallet.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: recipient
      })

      if (derivedKeyResult == null || derivedKeyResult.trim() === '') {
        throw new Error('Failed to derive recipient\'s public key')
      }

      // Create locking script using recipient's public key
      const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.recipientFee,
        lockingScript,
        outputDescription: 'Recipient message fee',
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: recipient
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: (await anyoneWallet.getPublicKey({ identityKey: true })).publicKey
        }
      })
    }

    const { tx } = await this.walletClient.createAction({
      description,
      outputs: createActionOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, originator)

    if (tx == null) {
      throw new Error('Failed to create payment transaction')
    }

    return {
      tx,
      outputs,
      description
      // labels
    }
  }
}
