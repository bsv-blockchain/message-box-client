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
}

/**
 * Defines the structure of a message being sent
 */
interface SendMessageParams {
  recipient: string
  messageBox: string
  body: string | object
  messageId?: string
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
  messageIds: number[]
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
   * Getter to expose the identity key for testing purposes.
   * Uncomment to run tests.
   */
  public get testIdentityKey (): string | undefined {
    return this.myIdentityKey
  }

  /**
   * Getter to expose the socket for testing purposes.
   * Uncomment to run tests.
   */
  public get testSocket (): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
   * Establish an initial socket connection to a room
   * The room ID is based on your identityKey and the messageBox
   */
  async initializeConnection (): Promise<void> {
    if (this.myIdentityKey == null || this.myIdentityKey === '') {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
      this.myIdentityKey = keyResult.publicKey
    }

    if (this.myIdentityKey == null || this.myIdentityKey === '') {
      throw new Error('Identity key is missing')
    }

    // Initialize WebSocket connection only if not already connected
    if (this.socket == null) {
      this.socket = AuthSocketClient(this.peerServHost, {
        wallet: this.walletClient
      })

      this.socket.on('connect', () => {
        console.log('Connected to MessageBox server via WebSocket')
      })

      this.socket.on('disconnect', () => {
        console.log('Disconnected from MessageBox server')
      })
    }
  }

  /**
   * Start listening on your "public" message room
   */
  async listenForLiveMessages ({
    onMessage,
    messageBox
  }: { onMessage: (message: any) => void, messageBox: string }): Promise<void> {
    await this.initializeConnection()

    if (this.socket == null) {
      throw new Error('WebSocket connection not initialized')
    }

    const roomId = `${this.myIdentityKey ?? ''}-${messageBox}`
    this.socket.emit('joinRoom', roomId)

    this.socket.on(`sendMessage-${roomId}`, (message) => {
      onMessage(message)
    })
  }

  /**
   * Send a message over sockets, with a backup of messageBox delivery
   */
  async sendLiveMessage ({ body, messageBox, recipient }: { body: string, messageBox: string, recipient: string }): Promise<void> {
    await this.initializeConnection()

    if (this.socket == null || this.socket === undefined) {
      throw new Error('WebSocket connection not initialized')
    }

    if (recipient.trim() === '') {
      throw new Error('Recipient cannot be empty')
    }

    const hmac = await this.walletClient.createHmac({
      protocolID: [0, 'PeerServ'],
      keyID: '1',
      data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
      counterparty: recipient
    })

    const messageId = Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')

    this.socket.emit('sendMessage', {
      roomId: `${recipient}-${messageBox}`,
      message: {
        sender: this.myIdentityKey,
        recipient,
        messageBox,
        messageId,
        body
      }
    })
  }

  /**
   * Sends a message to a PeerServ recipient
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

    const hmac = await this.walletClient.createHmac({
      data: Array.from(new TextEncoder().encode(JSON.stringify(message.body))),
      protocolID: [0, 'PeerServ'],
      keyID: '1',
      counterparty: message.recipient
    })

    const messageId = message.messageId ??
      Array.from(hmac.hmac).map(b => b.toString(16).padStart(2, '0')).join('')

    const response = await this.authFetch.fetch(`${this.peerServHost}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { ...message, messageId, body: JSON.stringify(message.body) } })
    })

    const parsedResponse = await response.json()

    if (parsedResponse.status === 'error') {
      throw new Error(parsedResponse.description)
    }

    return { ...parsedResponse, messageId }
  }

  /**
   * Lists messages from PeerServ
   */
  async listMessages ({ messageBox }: ListMessagesParams): Promise<PeerServMessage[]> {
    if (messageBox.trim() === '') throw new Error('MessageBox cannot be empty')

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
