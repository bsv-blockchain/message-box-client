import { WalletClient, AuthFetch } from '@bsv/sdk'

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
class Tokenator {
  private readonly peerServHost: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletClient
  private readonly joinedRooms: string[] = []
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
   * Establish an initial socket connection to a room
   * The room ID is based on your identityKey and the messageBox
   */
  async initializeConnection (messageBox: string): Promise<string> {
    if (this.myIdentityKey === null || this.myIdentityKey === undefined) {
      const keyResult = await this.walletClient.getPublicKey({ identityKey: true })
      this.myIdentityKey = keyResult.publicKey
    }

    if (this.myIdentityKey == null || messageBox.trim().length === 0) {
      throw new Error('Identity key or messageBox is missing')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`
    if (!this.joinedRooms.includes(roomId)) {
      this.joinedRooms.push(roomId)
    }

    return roomId
  }

  /**
   * Start listening on your "public" message room
   */
  async listenForLiveMessages ({
    onMessage,
    messageBox,
    autoAcknowledge = true
  }: { onMessage: (message: PeerServMessage) => void, messageBox: string, autoAcknowledge?: boolean }): Promise<void> {
    await this.initializeConnection(messageBox)
  }

  /**
   * Send a message over sockets, with a backup of messageBox delivery
   */
  async sendLiveMessage ({ body, messageBox, recipient }: SendMessageParams): Promise<void> {
    await this.initializeConnection(messageBox)
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

    try {
      await this.sendMessage({ recipient, messageBox, body, messageId })
    } catch (error: any) {
      if ((error as Error).message.includes('Payment required')) {
        console.warn('Payment required for live message:', error)

        // Retry sending with payment if necessary
        await this.sendMessage({ recipient, messageBox, body, messageId })
      } else {
        throw error // Other errors should still be thrown
      }
    }
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

    let response = await this.authFetch.fetch(`${this.peerServHost}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { ...message, messageId, body: JSON.stringify(message.body) } })
    })

    // Check if payment is required
    if (response.status === 402) {
      console.warn('402 Payment Required: Fetching payment details...')

      const satoshisRequired = Number(response.headers.get('x-bsv-payment-satoshis-required'))
      const derivationPrefix = response.headers.get('x-bsv-payment-derivation-prefix')

      if (derivationPrefix === null || derivationPrefix === '' || isNaN(satoshisRequired)) {
        throw new Error('Invalid payment request from server')
      }

      // Generate the payment transaction using the wallet
      const paymentTransaction = await this.walletClient.createAction({
        description: 'Payment for sending a message',
        outputs: [
          {
            satoshis: satoshisRequired,
            lockingScript: '', // Ensure the correct script is provided
            outputDescription: 'Payment Output',
            customInstructions: JSON.stringify({ derivationPrefix })
          }
        ]
      })

      // Retry request with payment included
      response = await this.authFetch.fetch(`${this.peerServHost}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bsv-payment': JSON.stringify({
            derivationPrefix,
            derivationSuffix: 'user-specific-data', // Can be empty or used for metadata
            transaction: paymentTransaction.tx // ✅ Correct property
          })
        },
        body: JSON.stringify({ message: { ...message, messageId, body: JSON.stringify(message.body) } })
      })
    }

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

export default Tokenator
