import { WalletClient, AuthFetch, LookupResolver } from '@bsv/sdk'
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
 * Defines the structure of an overlay ad
 */
// interface OverlayAd {
//   identity_key: string
//   host: string
// }

/**
 * Extendable class for interacting with a MessageBoxServer
 */
export class MessageBoxClient {
  private readonly host: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletClient
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string
  private readonly overlayEnabled: boolean
  private readonly joinedRooms: Set<string> = new Set()
  private readonly lookupResolver: LookupResolver

  constructor ({
    host = 'https://messagebox.babbage.systems',
    walletClient,
    enableLogging = false,
    overlayEnabled = false,
    networkPreset = 'local'
  }: {
    host?: string
    walletClient: WalletClient
    enableLogging?: boolean
    overlayEnabled?: boolean
    networkPreset?: 'local' | 'mainnet' | 'testnet'
  }) {
    this.host = host
    this.walletClient = walletClient
    this.authFetch = new AuthFetch(this.walletClient)
    this.overlayEnabled = overlayEnabled

    // ✅ Configure LookupResolver with dynamic networkPreset
    // const isBrowser = typeof window !== 'undefined'
    // const isLocalhost = isBrowser ? location.hostname === 'localhost' : false

    this.lookupResolver = new LookupResolver({
      networkPreset
    })

    if (enableLogging) {
      Logger.enable()
    }
  }

  /**
  * Getter for joinedRooms to use in tests
  */
  public getJoinedRooms (): Set<string> {
    return this.joinedRooms
  }

  public getIdentityKey (): string {
    if (this.myIdentityKey == null) {
      throw new Error('[MB CLIENT ERROR] Identity key is not set')
    }
    return this.myIdentityKey
  }

  // Add a getter for testing purposes
  public get testSocket (): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
  * Establish an initial WebSocket connection (optional)
  */
  async initializeConnection (): Promise<void> {
    Logger.log('[MB CLIENT] initializeConnection() STARTED') // 🔹 Confirm function is called

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
   * Looks up the most recently anointed host for a recipient using the overlay via LookupResolver.
   */
  private async resolveHostForRecipient (identityKey: string): Promise<string | null> {
    try {
      const result = await this.lookupResolver.query({
        service: 'lsmessagebox',
        query: { identityKey }
      })

      if (
        result != null &&
        typeof result === 'object' &&
        'type' in result &&
        result.type === 'freeform' &&
        'hosts' in result &&
        Array.isArray((result as any).hosts)
      ) {
        const hosts = (result as any).hosts
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
   * Determines the appropriate host for the recipient (local or overlay).
   */
  private async determineTargetHost (recipient: string): Promise<string> {
    if (!this.overlayEnabled) {
      return this.host
    }

    const overlayHost = await this.resolveHostForRecipient(recipient)
    return overlayHost ?? this.host
  }

  /**
   * Join a WebSocket room before sending messages
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
      Logger.log(`[MB CLIENT] Received message in room ${roomId}:`, message)
      onMessage(message)
    })
  }

  /**
 * Sends a message over WebSocket if connected; falls back to HTTP otherwise.
 */
  async sendLiveMessage ({ recipient, messageBox, body }: SendMessageParams): Promise<SendMessageResponse> {
    if (recipient == null || recipient.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Recipient identity key is required')
    }
    if (messageBox == null || messageBox.trim() === '') {
      throw new Error('[MB CLIENT ERROR] MessageBox is required')
    }
    if (body == null || (typeof body === 'string' && body.trim() === '')) {
      throw new Error('[MB CLIENT ERROR] Message body cannot be empty')
    }

    // Ensure WebSocket connection and room join before sending
    await this.joinRoom(messageBox)

    if (this.socket == null || !this.socket.connected) {
      Logger.warn('[MB CLIENT WARNING] WebSocket not connected, falling back to HTTP')
      const targetHost = await this.determineTargetHost(recipient)
      return await this.sendMessage({ recipient, messageBox, body }, targetHost)
    }

    // Generate message ID
    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
        protocolID: [0, 'messagebox'],
        keyID: '1',
        counterparty: recipient
      })
      messageId = Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    const roomId = `${recipient}-${messageBox}`
    Logger.log(`[MB CLIENT] Sending WebSocket message to room: ${roomId}`)

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
      } // ✅ This closing brace was missing

      this.socket?.on(ackEvent, ackHandler)

      this.socket?.emit('sendMessage', {
        roomId,
        message: {
          messageId,
          recipient,
          body: typeof body === 'string' ? body : JSON.stringify(body)
        }
      })

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
   * Leaves a WebSocket room.
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
   * Closes WebSocket connection.
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
   * Sends a message via HTTP
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

    // Generate HMAC
    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
        protocolID: [0, 'messagebox'],
        keyID: '1',
        counterparty: message.recipient
      })
      messageId = message.messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    const requestBody = {
      message: { ...message, messageId, body: JSON.stringify(message.body) }
    }

    try {
      const finalHost = overrideHost ?? this.host

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

      const authHeaders = {
        'Content-Type': 'application/json'
      }

      Logger.log('[MB CLIENT] Sending Headers:', JSON.stringify(authHeaders, null, 2))

      const response = await this.authFetch.fetch(`${finalHost}/sendMessage`, {
        method: 'POST',
        headers: authHeaders,
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
   * Allows a user to explicitly anoint a host to receive their messages.
   */
  async anointHost (host: string): Promise<void> {
    if (!host.startsWith('http')) {
      throw new Error('Invalid host URL')
    }

    const identityKey = this.getIdentityKey()

    const response = await this.authFetch.fetch(`${this.host}/overlay/anoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: identityKey
      },
      body: JSON.stringify({ host })
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(`Request failed with status: ${response.status} - ${message}`)
    }
  }

  /**
 * Lists messages from MessageBoxServer or an overlay host
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
        'Content-Type': 'application/json',
        Authorization: this.getIdentityKey() // <-- Fix!
      },
      body: JSON.stringify({ messageBox })
    })

    const parsedResponse = await response.json()

    if (parsedResponse.status === 'error') {
      throw new Error(parsedResponse.description)
    }

    return parsedResponse.messages
  }

  /**
 * Acknowledges one or more messages as having been received
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
        'Content-Type': 'application/json',
        Authorization: this.getIdentityKey() // <-- Fix!
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
