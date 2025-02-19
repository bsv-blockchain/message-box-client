import { AuthSocketClient } from '@bsv/authsocket'
import { WalletClient } from '@bsv/sdk'

describe('MessageBoxClient WebSocket Tests', () => {
  let socket: ReturnType<typeof AuthSocketClient>

  beforeAll(async () => {
    const walletClient = new WalletClient()
    socket = AuthSocketClient('http://localhost:4000', { wallet: walletClient })

    await new Promise(resolve => {
      socket.on('connect', resolve)
    })
  })

  afterAll(() => {
    if (typeof socket.disconnect === 'function') {
      socket.disconnect()
    } else {
      console.warn('No valid disconnect method found for AuthSocketClient')
    }
  })

  it('should send and receive a live message', (done) => {
    const roomId = 'recipient123-testBox'
    socket.emit('joinRoom', roomId)

    socket.on(`sendMessage-${roomId}`, (message) => {
      expect(message.body).toBe('Hello, WebSocket!')
      done()
    })

    socket.emit('sendMessage', {
      roomId,
      message: {
        sender: 'testSender',
        recipient: 'recipient123',
        messageBox: 'testBox',
        messageId: 'websocket-test',
        body: 'Hello, WebSocket!'
      }
    })
  })
})
