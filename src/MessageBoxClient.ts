/**
 * @file MessageBoxClient.ts
 * @description
 * This module provides the `MessageBoxClient` class, a client-side library for interacting with the Message Box Server.
 * It supports sending and receiving encrypted messages between authenticated users over HTTP or WebSocket,
 * using identity keys to ensure privacy, authenticity, and message integrity.
 *
 * MessageBoxClient supports both local and overlay-based routing. Overlay routing allows messages to be forwarded
 * to dynamically anointed hosts by resolving the most recently published advertisement for a given identity key.
 * This is achieved using the BSV SDK’s LookupResolver and TopicBroadcaster via overlay advertisements.
 *
 * Key Features:
 * - Authenticated HTTP and WebSocket message sending and receipt
 * - Deterministic message ID generation via HMAC
 * - Optional message encryption using CurvePoint-AES with symmetric keys
 * - Identity-based overlay host resolution using `ls_messagebox`
 * - Host advertisement broadcasting using PushDrop and overlay topics
 * - Live message streaming with room-based WebSocket channels
 * - Secure message acknowledgment and persistent inboxes via `messageBox` types
 *
 * This class is used by frontend or service-layer clients who want to send or receive messages via the Message Box Server.
 * For details on message structure, encryption, and overlay mechanics, refer to the associated documentation.
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
  Base64String
} from '@bsv/sdk'
import { AuthSocketClient } from '@bsv/authsocket-client'
import { Logger } from './Utils/logger.js'

/**
 * Defines the structure of a PeerMessage
 */
export interface PeerMessage {
  messageId: string
  body: string
  sender: string
  created_at: string
  updated_at: string
  acknowledged?: boolean
}

/**
 * Defines the structure of a message being sent
 */
export interface SendMessageParams {
  recipient: string
  messageBox: string
  body: string | object
  messageId?: string
  skipEncryption?: boolean
}

/**
 * Defines the structure of the response from sendMessage
 */
export interface SendMessageResponse {
  status: string
  messageId: string
}

/**
 * Defines the structure of a request to acknowledge messages
 */
export interface AcknowledgeMessageParams {
  messageIds: string[]
}

/**
 * Defines the structure of a request to list messages
 */
export interface ListMessagesParams {
  messageBox: string
}

/**
 * Defines the structure of a message that is encrypted
 */
export interface EncryptedMessage {
  encryptedMessage: Base64String
}

/**
 * @class MessageBoxClient
 * @description
 * Client for interacting with a MessageBoxServer or overlay network. Enables:
 * - Secure and encrypted messaging via HTTP or WebSocket
 * - HMAC-based message IDs for tamper resistance
 * - Dynamic overlay resolution of recipient hosts via LookupResolver
 * - Host advertisement broadcasting using PushDrop outputs
 * - Streaming real-time message support via WebSocket rooms
 *
 * @example
 * const mb = new MessageBoxClient({ walletClient, overlayEnabled: true })
 * await mb.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello world' })
 */
export class MessageBoxClient {
  private readonly host: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletClient
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string
  private readonly joinedRooms: Set<string> = new Set()
  private readonly lookupResolver: LookupResolver

  /**
   * @constructor
   * @param options.host - Base URL of the MessageBox server
   * @param options.walletClient - WalletClient instance for identity and crypto operations
   * @param options.enableLogging - If true, enables structured logging
   * @param options.networkPreset - LookupResolver overlay network ('local', 'mainnet', or 'testnet')
   */
  constructor ({
    host = 'https://messagebox.babbage.systems',
    walletClient,
    enableLogging = false,
    networkPreset = 'local'
  }: {
    host?: string
    walletClient: WalletClient
    enableLogging?: boolean
    networkPreset?: 'local' | 'mainnet' | 'testnet'
  }) {
    this.host = host
    this.walletClient = walletClient
    this.authFetch = new AuthFetch(this.walletClient)

    this.lookupResolver = new LookupResolver({
      networkPreset
    })

    if (enableLogging) {
      Logger.enable()
    }
  }

  /**
   * @method getJoinedRooms
   * @returns {Set<string>}
   * @description Returns the current set of WebSocket room IDs that the client has joined.
   * This is primarily used for inspection and testing purposes.
   */
  public getJoinedRooms (): Set<string> {
    return this.joinedRooms
  }

  /**
   * @method getIdentityKey
   * @returns {string}
   * @throws {Error} If the identity key has not been fetched or set yet.
   * @description Returns the current identity key used by the client. This is fetched during setup
   * and used for both authentication and encryption operations.
   */
  public getIdentityKey (): string {
    if (this.myIdentityKey == null) {
      throw new Error('[MB CLIENT ERROR] Identity key is not set')
    }
    return this.myIdentityKey
  }

  /**
   * @property testSocket
   * @readonly
   * @returns {AuthSocketClient | undefined}
   * @description Exposes the internal WebSocket client for testing or inspection.
   */
  public get testSocket (): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
   * @method initializeConnection
   * @async
   * @returns {Promise<void>}
   * @description Establishes an authenticated WebSocket connection to the MessageBox server.
   * This connection allows the client to send and receive real-time messages in WebSocket rooms.
   *
   * Steps:
   * 1. Fetches the user's identity key if not already loaded.
   * 2. Creates a new WebSocket connection using AuthSocketClient.
   * 4. Waits for `authenticationSuccess` or fails after a timeout.
   *
   * Authentication ensures only valid users join rooms and send messages.
   */
  async initializeConnection (): Promise<void> {
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
   * @private
   * @async
   * @param {string} identityKey - The public identity key of the message recipient.
   * @returns {Promise<string | null>} - The most recently anointed host for this identity, or `null` if not found.
   *
   * @description
   * Uses the overlay LookupResolver to find the most recently anointed MessageBox host for a given recipient.
   * This enables clients to determine where to route overlay-based messages.
   */
  private async resolveHostForRecipient (identityKey: string): Promise<string | null> {
    try {
      const result = await this.lookupResolver.query({
        service: 'ls_messagebox',
        query: { identityKey }
      })

      if (
        result != null &&
        typeof result === 'object' &&
        'type' in result &&
        result.type === 'freeform' &&
        'result' in result &&
        Array.isArray((result as any).result?.hosts)
      ) {
        const hosts = (result as any).result.hosts
        if (hosts.length > 0) {
          Logger.log(`[MB CLIENT] Host found via LookupResolver: ${String(hosts[0])}`)
          return hosts[0]
        } else {
          Logger.warn(`[MB CLIENT] LookupResolver returned empty host list for ${identityKey}`)
        }
      } else {
        Logger.warn(`[MB CLIENT] Unexpected result from LookupResolver: ${JSON.stringify(result)}`)
      }
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to resolve host from LookupResolver:', error)
    }

    return null
  }

  /**
   * @method determineTargetHost
   * @private
   * @async
   * @param {string} recipient - The recipient’s identity key.
   * @returns {Promise<string>} - The host to use for routing the message (overlay if available, else default).
   *
   * @description
   * Selects the appropriate server to send messages to. Falls back to the default host if none is found.
   */
  private async determineTargetHost (recipient: string): Promise<string> {
    const overlayHost = await this.resolveHostForRecipient(recipient)
    return overlayHost ?? this.host
  }

  /**
   * @method joinRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to join.
   * @returns {Promise<void>}
   *
   * @description
   * Ensures the client joins a WebSocket room for receiving live messages.
   * This function will initialize a WebSocket connection if needed and send an `authenticated` event
   * followed by a `joinRoom` event. It ensures no duplicate joins for already joined rooms.
   */
  async joinRoom (messageBox: string): Promise<void> {
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
   * @param {function} params.onMessage - A callback function that will be called when a new message is received.
   * @param {string} params.messageBox - The name of the message box to listen on (usually tied to a protocol or purpose).
   * @returns {Promise<void>}
   *
   * @description
   * Listens for live WebSocket messages from the specified message box. This function:
   * - Ensures the socket is connected and authenticated
   * - Joins the appropriate WebSocket room
   * - Decrypts incoming encrypted messages before invoking the callback
   */
  async listenForLiveMessages ({
    onMessage,
    messageBox
  }: {
    onMessage: (message: PeerMessage) => void
    messageBox: string
  }): Promise<void> {
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
          const parsedBody = typeof message.body === 'string' ? JSON.parse(message.body) : message.body

          if (
            parsedBody !== null && typeof parsedBody === 'object' &&
            typeof parsedBody === 'object' &&
            typeof parsedBody.encryptedMessage === 'string'
          ) {
            Logger.log(`[MB CLIENT] Decrypting message from ${String(message.sender)}...`)
            const decrypted = await this.walletClient.decrypt({
              protocolID: [1, 'messagebox'],
              keyID: '1',
              counterparty: message.sender === this.getIdentityKey() ? 'self' : message.sender,
              ciphertext: Utils.toArray(parsedBody.encryptedMessage, 'base64')
            })

            message.body = Utils.toUTF8(decrypted.plaintext)
          } else {
            Logger.log('[MB CLIENT] Message is not encrypted.')
            message.body = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody)
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
   * @param {SendMessageParams} param0 - The message parameters including recipient, box, and body.
   * @returns {Promise<SendMessageResponse>}
   *
   * @description
   * Attempts to send a message in real time using WebSockets. If the socket is unavailable or fails,
   * the method falls back to sending via HTTP. Message bodies are encrypted, and an HMAC is used
   * to generate a unique message ID.
   */
  async sendLiveMessage ({
    recipient,
    messageBox,
    body,
    messageId,
    skipEncryption
  }: SendMessageParams): Promise<SendMessageResponse> {
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
      const targetHost = await this.determineTargetHost(recipient)
      return await this.sendMessage({ recipient, messageBox, body }, targetHost)
    }

    let finalMessageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
        protocolID: [1, 'messagebox'],
        keyID: '1',
        counterparty: recipient === this.getIdentityKey() ? 'self' : recipient
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
        counterparty: recipient === this.getIdentityKey() ? 'self' : recipient,
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
          Logger.warn('[MB CLIENT] WebSocket message failed, falling back to HTTP')
          this.determineTargetHost(recipient)
            .then(async (host) => {
              return await this.sendMessage({ recipient, messageBox, body }, host)
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
          body: JSON.stringify(outgoingBody)
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
          this.determineTargetHost(recipient)
            .then(async (host) => {
              return await this.sendMessage({ recipient, messageBox, body }, host)
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
   * @param {string} messageBox - The name of the message box (WebSocket room) to leave.
   * @returns {Promise<void>}
   *
   * @description
   * Leaves a previously joined WebSocket room. This is useful for reducing unnecessary
   * WebSocket traffic or managing room membership dynamically.
   */
  async leaveRoom (messageBox: string): Promise<void> {
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
   * @returns {Promise<void>}
   *
   * @description
   * Gracefully closes the WebSocket connection if it's active.
   * Useful for client shutdown, logout, or transitioning between identities.
   */
  async disconnectWebSocket (): Promise<void> {
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
   * @param {SendMessageParams} message - The recipient, messageBox, body, and optional messageId.
   * @param {string} [overrideHost] - Optionally override the resolved or default server host.
   * @returns {Promise<SendMessageResponse>}
   *
   * @description
   * Sends a message over HTTP. Automatically encrypts the message body for the recipient
   * and generates a unique messageId using an HMAC. Uses overlay lookup to resolve the correct
   * host if `overlayEnabled` is true. Falls back to default host if no overlay is found.
   */
  async sendMessage (
    message: SendMessageParams,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
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
        counterparty: message.recipient === this.getIdentityKey() ? 'self' : message.recipient,
        plaintext: Utils.toArray(typeof message.body === 'string' ? message.body : JSON.stringify(message.body), 'utf8')
      })

      finalBody = {
        encryptedMessage: Utils.toBase64(encryptedMessage.ciphertext)
      }
    }

    const requestBody = {
      message: {
        ...message,
        messageId,
        body: finalBody
      }
    }

    try {
      const finalHost = overrideHost ?? await this.determineTargetHost(message.recipient)

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

      Logger.log('[MB CLIENT] Raw Response:', response)
      Logger.log('[MB CLIENT] Response Body Used?', response.bodyUsed)

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
   * @param {string} host - The full URL of the host you wish to anoint for receiving your messages.
   * @returns {Promise<{ txid: string }>} - The transaction ID of the successfully broadcasted advertisement.
   *
   * @description
   * Creates and broadcasts an overlay advertisement transaction that announces the provided host as
   * authorized to receive messages for the user's identity key. This is done by creating a signed
   * PushDrop output with host, timestamp, and nonce metadata, and then broadcasting the resulting transaction
   * to the overlay network under the `tm_messagebox` topic.
   *
   * The server receiving messages for the identity key must validate this advertisement to admit messages.
   * This method ensures decentralized routing is possible based on user-specified preferences.
   *
   * @throws {Error} If the host URL is invalid or if broadcasting fails.
   */
  async anointHost (host: string): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting anointHost...')
    try {
      if (!host.startsWith('http')) {
        throw new Error('Invalid host URL')
      }

      const identityKey = this.getIdentityKey()
      const timestamp = new Date().toISOString()
      const nonce = Math.random().toString(36).slice(2)

      Logger.log('[MB CLIENT] Fields - Identity:', identityKey, 'Host:', host, 'Timestamp:', timestamp, 'Nonce:', nonce)

      const fields: number[][] = [
        Utils.toArray(identityKey, 'hex'),
        Utils.toArray(host, 'utf8'),
        Utils.toArray(timestamp, 'utf8'),
        Utils.toArray(nonce, 'utf8')
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
          networkPreset: 'local'
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
   * @method listMessages
   * @async
   * @param {ListMessagesParams} params - The message box name to retrieve messages from.
   * @returns {Promise<PeerMessage[]>} - A list of parsed and optionally decrypted messages.
   *
   * @description
   * Queries the MessageBox server (or overlay-resolved host if enabled) for all messages
   * in a specific messageBox. If any messages are encrypted, they are decrypted
   * using the sender’s public key and the local user's wallet.
   * @throws {Error} If the messageBox is empty, or if the server response indicates failure.
   */
  async listMessages ({ messageBox }: ListMessagesParams): Promise<PeerMessage[]> {
    if (messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }

    const identityKey = this.getIdentityKey()
    const targetHost = await this.determineTargetHost(identityKey)

    const response = await this.authFetch.fetch(`${targetHost}/listMessages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messageBox })
    })

    const parsedResponse = await response.json()

    if (parsedResponse.status === 'error') {
      throw new Error(parsedResponse.description)
    }

    for (const message of parsedResponse.messages) {
      try {
        const parsedBody = typeof message.body === 'string' ? JSON.parse(message.body) : message.body

        if (
          parsedBody !== null && typeof parsedBody === 'object' &&
          typeof parsedBody === 'object' &&
          typeof parsedBody.encryptedMessage === 'string'
        ) {
          Logger.log(`[MB CLIENT] Decrypting message from ${String(message.sender)}...`)
          const decrypted = await this.walletClient.decrypt({
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: message.sender === this.getIdentityKey() ? 'self' : message.sender,
            ciphertext: Utils.toArray(parsedBody.encryptedMessage, 'base64')
          })

          message.body = Utils.toUTF8(decrypted.plaintext)
        } else {
          message.body = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody)
        }
      } catch (err) {
        Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt message in list:', err)
        message.body = '[Error: Failed to decrypt or parse message]'
      }
    }

    return parsedResponse.messages
  }

  /**
   * @method acknowledgeMessage
   * @async
   * @param {AcknowledgeMessageParams} params - An object containing an array of message IDs to acknowledge.
   * @returns {Promise<string>} - Returns the success status string from the server response.
   *
   * @description
   * Acknowledges one or more messages previously received from the MessageBoxServer or an overlay-resolved host.
   * Acknowledged messages can then be deleted from the server-side storage.
   *
   * This method authenticates using the local identity key and notifies the message server
   * that the specified messages were successfully received and processed.
   *
   * @throws {Error} If the messageIds array is empty, or the request fails.
   */
  async acknowledgeMessage ({ messageIds }: AcknowledgeMessageParams): Promise<string> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('Message IDs array cannot be empty')
    }

    Logger.log(`[MB CLIENT] Acknowledging messages: ${JSON.stringify(messageIds)}`)

    const identityKey = this.getIdentityKey()
    const targetHost = await this.determineTargetHost(identityKey)

    const acknowledged = await this.authFetch.fetch(`${targetHost}/acknowledgeMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messageIds })
    })

    const parsedAcknowledged = await acknowledged.json()

    if (parsedAcknowledged.status === 'error') {
      throw new Error(parsedAcknowledged.description)
    }

    return parsedAcknowledged.status
  }
}
