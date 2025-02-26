import { WalletClient, AuthFetch } from '@bsv/sdk'
import { AuthSocketClient } from '@bsv/authsocket'

/**
 * Defines the structure of a PeerServ Message
 */
interface PeerServMessage {
  messageId: number
  body: string
  sender: string
  created_at: string
  updated_at: string
  acknowledged?: boolean
}

/**
 * Defines the structure of a message being sent
 */
interface SendMessageParams {
  recipient: string
  messageBox: string
  body: string | object
  messageId?: string
  payment?: { satoshisPaid: number }
}

/**
 * Defines the structure of the response from sendMessage
 */
interface SendMessageResponse {
  status: string
  messageId: string
}

/**
 * Defines the structure of a request to acknowledge messages
 */
interface AcknowledgeMessageParams {
  messageIds: string[]
}

/**
 * Defines the structure of a request to list messages
 */
interface ListMessagesParams {
  messageBox: string
}

/**
 * Extendable class for interacting with a PeerServ
 */
class MessageBoxClient {
  private readonly peerServHost: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletClient
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string

  constructor ({
    peerServHost = 'https://staging-peerserv.babbage.systems',
    walletClient
  }: { peerServHost?: string, walletClient: WalletClient }) {
    this.peerServHost = peerServHost
    this.walletClient = walletClient
    this.authFetch = new AuthFetch(this.walletClient)
  }

  /**
   * Calculates the required payment for sending a message.
   * This function matches the pricing logic on the server.
   */
  calculateMessagePrice (message: string, priority: boolean = false): number {
    const basePrice = 500 // Base fee in satoshis
    const sizeFactor = Math.ceil(Buffer.byteLength(message, 'utf8') / 1024) * 50 // 50 satoshis per KB
    const priorityFee = priority ? 200 : 0 // Additional fee for priority messages

    const totalPrice = basePrice + sizeFactor + priorityFee
    console.log(`[CLIENT] Calculated message price: ${totalPrice} satoshis`)

    return totalPrice
  }

  /**
   * Establish an initial WebSocket connection (optional)
   */
  async initializeConnection (): Promise<void> {
    console.log('[CLIENT] initializeConnection() called')

    if (this.myIdentityKey == null || this.myIdentityKey === '') {
      console.log('[CLIENT] Fetching identity key...')
      try {
        const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
        this.myIdentityKey = keyResult.publicKey
        console.log(`[CLIENT] Identity key fetched: ${this.myIdentityKey}`)
      } catch (error) {
        console.error('[CLIENT ERROR] Failed to fetch identity key:', error)
        throw new Error('Identity key retrieval failed')
      }
    }

    if (this.myIdentityKey == null || this.myIdentityKey === '') {
      console.error('[CLIENT ERROR] Identity key is missing!')
      throw new Error('Identity key is missing')
    }

    console.log('[CLIENT] Setting up WebSocket connection...')

    if (this.socket == null) {
      this.socket = AuthSocketClient(this.peerServHost, { wallet: this.walletClient })

      this.socket.on('connect', () => {
        console.log('[CLIENT] Connected to WebSocket. Sending authentication data...')
        if (this.socket !== null && this.socket !== undefined) {
          this.socket.emit('authenticate', { identityKey: this.myIdentityKey })
        } else {
          console.error('[CLIENT ERROR] Attempted to use WebSocket before initialization')
        }
      })

      this.socket.on('disconnect', () => {
        console.log('[CLIENT] Disconnected from MessageBox server')
      })

      this.socket.on('error', (error) => {
        console.error('[CLIENT ERROR] WebSocket error:', error)
      })
    }
  }

  /**
   * Sends a message via HTTP
   */
  async sendMessage (message: SendMessageParams): Promise<SendMessageResponse> {
    if (message.recipient == null || message.recipient.trim() === '') {
      throw new Error('You must provide a message recipient!')
    }
    if (message.messageBox == null || message.messageBox.trim() === '') {
      throw new Error('You must provide a messageBox to send this message into!')
    }
    if (message.body == null || (typeof message.body === 'string' && message.body.trim().length === 0)) {
      throw new Error('Every message must have a body!')
    }

    // Calculate required payment
    const requiredSatoshis = this.calculateMessagePrice(JSON.stringify(message.body), false)
    console.log(`[CLIENT] Calculated message price: ${requiredSatoshis} satoshis`)

    // Generate HMAC
    let messageId: string
    try {
      const hmac = await this.walletClient.createHmac({
        data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
        protocolID: [0, 'PeerServ'],
        keyID: '1',
        counterparty: message.recipient
      })
      messageId = message.messageId ?? Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (error) {
      console.error('[CLIENT ERROR] Failed to generate HMAC:', error)
      throw new Error('Failed to generate message identifier.')
    }

    console.log(`[CLIENT] Sending message with ID ${messageId} and payment: ${requiredSatoshis} satoshis`)

    const requestBody = {
      message: { ...message, messageId, body: JSON.stringify(message.body) },
      payment: { satoshisPaid: requiredSatoshis }
    }

    try {
      console.log('[CLIENT] Sending HTTP request to:', `${this.peerServHost}/sendMessage`)
      console.log('[CLIENT] Request Body:', JSON.stringify(requestBody, null, 2))

      // Set a manual timeout using Promise.race()
      const timeoutPromise = new Promise<Response>((_resolve, reject) =>
        setTimeout(() => reject(new Error('[CLIENT ERROR] Request timed out!')), 10000)
      )

      console.log('[CLIENT] Awaiting response from:', `${this.peerServHost}/sendMessage`)

      // Attempt to fetch, racing against timeout
      const response = await Promise.race([
        this.authFetch.fetch(`${this.peerServHost}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }),
        timeoutPromise
      ])

      console.log('[CLIENT] Raw Response:', response)

      const rawResponseText = await response.text()
      console.log('[CLIENT] Raw Response Body:', rawResponseText)

      if (!response.ok) {
        console.error(`[CLIENT ERROR] Failed to send message. HTTP ${response.status}: ${response.statusText}`)
        throw new Error(`Message sending failed: HTTP ${response.status} - ${response.statusText}`)
      }

      const parsedResponse = await response.json()
      console.log('[CLIENT] Received Response:', JSON.stringify(parsedResponse, null, 2))

      if (parsedResponse.status !== 'success') {
        console.error(`[CLIENT ERROR] Server returned an error: ${String(parsedResponse.description)}`)
        throw new Error(parsedResponse.description ?? 'Unknown error from server.')
      }

      console.log('[CLIENT] Message successfully sent.')
      return { ...parsedResponse, messageId }
    } catch (error) {
      console.error('[CLIENT ERROR] Network or timeout error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to send message: ${errorMessage}`)
    }
  }

  /**
   * Lists messages from PeerServ
   */
  async listMessages ({ messageBox }: ListMessagesParams): Promise<PeerServMessage[]> {
    if (messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }

    const response = await this.authFetch.fetch(`${this.peerServHost}/listMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const acknowledged = await this.authFetch.fetch(`${this.peerServHost}/acknowledgeMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds })
    })

    const parsedAcknowledged = await acknowledged.json()

    if (parsedAcknowledged.status === 'error') {
      throw new Error(parsedAcknowledged.description)
    }

    return parsedAcknowledged.status
  }
}

export default MessageBoxClient
