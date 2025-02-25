/* eslint-env jest */
import WebSocket from 'ws'
import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

const WS_URL = 'ws://localhost:8080'

let wsClient: WebSocket
let recipientKey: string
let testMessageId: string
const messageBox = 'testBox'
const testMessage = 'Hello, this is a WebSocket integration test.'

const messageBoxClient = new MessageBoxClient({
  peerServHost: WS_URL,
  walletClient: new WalletClient('auto')
})

describe('MessageBoxClient WebSocket Integration Tests', () => {
  beforeAll((done) => {
    wsClient = new WebSocket(WS_URL)

    wsClient.on('open', () => {
      console.log('WebSocket connected for testing.')
      done()
    })

    wsClient.on('error', (err) => {
      console.error('WebSocket error:', err)
    })
  })

  afterAll(() => {
    wsClient.close()
    console.log('WebSocket closed after tests.')
  })

  /** TEST 1: Authenticate WebSocket Connection **/
  test('should authenticate the WebSocket connection', async () => {
    expect(wsClient).toBeDefined()
    expect(wsClient.readyState).toBe(WebSocket.OPEN)
  })

  /** TEST 2: Send a Message via WebSocket **/
  test('should send a message successfully via WebSocket', async () => {
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage
    })

    expect(response.status).toBe('success')
    testMessageId = response.messageId
  })

  /** TEST 3: Attempt to Send Without Payment (Expect 402) **/
  test('should fail to send a message without payment', async () => {
    global.fetch = jest.fn(async () => new Response(null, { status: 402 })) // Mock 402 response

    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('Payment is required before sending messages.')
  })

  /** TEST 4: Receive the Sent Message **/
  test('should receive the sent message correctly', async () => {
    const receivedMessage = await new Promise((resolve) => {
      wsClient.on('message', (data) => {
        let message: string

        if (typeof data === 'string') {
          message = data
        } else if (data instanceof Buffer) {
          message = data.toString('utf8')
        } else if (data instanceof ArrayBuffer) {
          message = Buffer.from(data).toString('utf8')
        } else if (Array.isArray(data)) {
          message = Buffer.concat(data).toString('utf8')
        } else {
          throw new Error('Unexpected WebSocket message format')
        }

        resolve(JSON.parse(message))
      })
    })

    expect(receivedMessage).toHaveProperty('body', testMessage)
    expect(receivedMessage).toHaveProperty('recipient', recipientKey)
  })

  /** TEST 5: List Messages via WebSocket **/
  test('should list messages from messageBox via WebSocket', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0].body).toBe(testMessage)
  })

  /** TEST 6: Handle Unauthorized Access Properly **/
  test('should fail when accessing an unauthorized messageBox', async () => {
    try {
      await messageBoxClient.listMessages({ messageBox: 'unauthorizedBox' })
    } catch (error: any) {
      expect(error.message).toMatch(/Unauthorized|403/)
    }
  })

  /** TEST 7: Acknowledge a Message via WebSocket **/
  test('should acknowledge (delete) a message via WebSocket', async () => {
    const ackResponse = await messageBoxClient.acknowledgeMessage({ messageIds: [testMessageId] })
    expect(ackResponse).toBe('success')
  })

  /** TEST 8: Acknowledge a Nonexistent Message **/
  test('should fail to acknowledge a nonexistent message', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ status: 'error', description: 'Message not found!' }), { status: 404 }))

    await expect(
      messageBoxClient.acknowledgeMessage({ messageIds: ['fakeMessageId'] })
    ).rejects.toThrow('Message not found!')
  })

  /** TEST 9: Send Message with Invalid Recipient **/
  test('should fail if recipient is invalid', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: '', // Invalid recipient
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('You must provide a message recipient!')
  })

  /** TEST 10: Send Message with Empty Body **/
  test('should fail if message body is empty', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: '' // Empty message
      })
    ).rejects.toThrow('Every message must have a body!')
  })

  /** TEST 11: Attempt to Send WebSocket Message to Unauthorized Room **/
  test('should fail when sending a message to an unauthorized room', async () => {
    console.log('[TEST] Sending unauthorized message...')

    // Send a message to an unauthorized room
    wsClient.send(
      JSON.stringify({
        event: 'sendMessage',
        data: {
          roomId: 'unauthorized-room',
          message: {
            sender: 'testSender',
            recipient: 'recipient123',
            messageBox: 'testBox',
            messageId: 'websocket-test-unauthorized',
            body: 'This should fail'
          }
        }
      })
    )

    // Wait for server response
    const response = await new Promise<{ status: string, description: string }>((resolve) => {
      wsClient.on('message', (data: WebSocket.RawData) => {
        let message: string

        if (typeof data === 'string') {
          message = data
        } else if (data instanceof Buffer) {
          message = data.toString('utf8')
        } else if (data instanceof ArrayBuffer) {
          message = Buffer.from(data).toString('utf8')
        } else if (Array.isArray(data)) {
          message = Buffer.concat(data).toString('utf8')
        } else {
          console.error('Unexpected WebSocket message format:', data)
          throw new Error('Unexpected WebSocket message format')
        }

        resolve(JSON.parse(message))
      })
    })

    // Ensure the response contains the expected error message
    expect(response).toHaveProperty('status', 'error')
    expect(response).toHaveProperty('description', 'Unauthorized room access')
  })
})
