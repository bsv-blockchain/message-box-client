import { startTestServer, stopTestServer } from './testServer.js'
import { AuthSocketClient } from '@bsv/authsocket'
import { WalletClient } from '@bsv/sdk'

describe('Integration Test: WebSocket Messaging', () => {
  let senderSocket: ReturnType<typeof AuthSocketClient>
  let recipientSocket: ReturnType<typeof AuthSocketClient>
  const testRoom = 'recipient123-testBox'

  beforeAll(async () => {
    await startTestServer()

    const wallet = new WalletClient()
    senderSocket = AuthSocketClient('http://localhost:8080', { wallet })
    recipientSocket = AuthSocketClient('http://localhost:8080', { wallet })

    // Wait for both connections
    await new Promise((resolve) => senderSocket.on('connect', resolve))
    await new Promise((resolve) => recipientSocket.on('connect', resolve))
  })

  afterAll(async () => {
    if (senderSocket != null) senderSocket.disconnect()
    if (recipientSocket != null) recipientSocket.disconnect()
    await stopTestServer()
  })

  it('should send and receive a live WebSocket message', (done) => {
    recipientSocket.emit('joinRoom', testRoom)

    recipientSocket.on(`sendMessage-${testRoom}`, (message) => {
      expect(message.body).toBe('Hello, WebSocket!')
      done()
    })

    senderSocket.emit('sendMessage', {
      roomId: testRoom,
      message: {
        sender: 'testSender',
        recipient: 'recipient123',
        messageBox: 'testBox',
        messageId: 'websocket-test',
        body: 'Hello, WebSocket!'
      }
    })
  })

  it('should fail when sending a message to an unauthorized room', async () => {
    senderSocket.emit('sendMessage', {
      roomId: 'unauthorized-room',
      message: {
        sender: 'testSender',
        recipient: 'recipient123',
        messageBox: 'testBox',
        messageId: 'websocket-test-unauthorized',
        body: 'This should fail'
      }
    })

    // Since the server does not allow unauthorized room messages, we wait to see if nothing happens
    await new Promise((resolve) => setTimeout(resolve, 2000))
  })
})
