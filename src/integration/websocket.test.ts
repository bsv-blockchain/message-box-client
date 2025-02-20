import { startTestServer, stopTestServer } from './testServer.js'
import { AuthSocketClient } from '@bsv/authsocket'
import { WalletClient } from '@bsv/sdk'

describe('Integration Test: WebSocket Messaging', () => {
  let senderSocket: ReturnType<typeof AuthSocketClient>
  let recipientSocket: ReturnType<typeof AuthSocketClient>
  // const testRoom = 'recipient123-testBox'
  let wallet: WalletClient

  beforeAll(async () => {
    await startTestServer()

    wallet = new WalletClient()

    console.log('[TEST] Fetching identity key...')
    const keyResult = await wallet.getPublicKey({ identityKey: true })
    const identityKey = keyResult.publicKey
    console.log(`[TEST] Identity key retrieved: ${identityKey}`)

    senderSocket = AuthSocketClient('http://localhost:8080', { wallet })
    recipientSocket = AuthSocketClient('http://localhost:8080', { wallet })

    // Wait for both connections
    await new Promise((resolve) => senderSocket.on('connect', resolve))
    await new Promise((resolve) => recipientSocket.on('connect', resolve))

    console.log('[TEST] Both WebSocket connections established.')

    // ✅ Explicitly send authentication event to server
    senderSocket.emit('authenticate', { identityKey })
    recipientSocket.emit('authenticate', { identityKey })

    // Allow time for authentication processing
    await new Promise((resolve) => setTimeout(resolve, 1000))
  })

  afterAll(async () => {
    if (senderSocket !== null && senderSocket !== undefined) senderSocket.disconnect()
    if (recipientSocket !== null && recipientSocket !== undefined) recipientSocket.disconnect()
    await stopTestServer()
  })

  it('should authenticate the WebSocket connection', async () => {
    expect(senderSocket).toBeDefined()
    expect(recipientSocket).toBeDefined()

    // Allow time for authentication processing
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // ✅ Verify authentication success instead of checking identityKey
    senderSocket.emit('authenticate', { identityKey: 'test-sender-key' })
    recipientSocket.emit('authenticate', { identityKey: 'test-recipient-key' })

    console.log('[TEST] Authentication events sent.')

    // Wait for authentication to process
    await new Promise((resolve) => setTimeout(resolve, 1000))

    console.log('[TEST] Checking authentication response...')
    senderSocket.on('authenticated', () => {
      console.log('[TEST] Sender authenticated successfully.')
    })
    recipientSocket.on('authenticated', () => {
      console.log('[TEST] Recipient authenticated successfully.')
    })

    // ✅ Ensure WebSocket authentication was acknowledged
    let senderAuthenticated = false
    let recipientAuthenticated = false

    senderSocket.on('authenticated', () => {
      senderAuthenticated = true
    })
    recipientSocket.on('authenticated', () => {
      recipientAuthenticated = true
    })

    await new Promise((resolve) => setTimeout(resolve, 1000))

    expect(senderAuthenticated).toBe(true)
    expect(recipientAuthenticated).toBe(true)
  })

  // it('should send and receive a live WebSocket message', (done) => {
  //   recipientSocket.emit('joinRoom', testRoom)

  //   recipientSocket.on(`sendMessage-${testRoom}`, (message) => {
  //     console.log(`[TEST] Message received: ${JSON.stringify(message)}`)
  //     expect(message.body).toBe('Hello, WebSocket!')
  //     done()
  //   })

  //   senderSocket.emit('sendMessage', {
  //     roomId: testRoom,
  //     message: {
  //       sender: 'testSender',
  //       recipient: 'recipient123',
  //       messageBox: 'testBox',
  //       messageId: 'websocket-test',
  //       body: 'Hello, WebSocket!'
  //     }
  //   })
  // })

  // it('should fail when sending a message to an unauthorized room', async () => {
  //   console.log('[TEST] Sending unauthorized message...')
  //   senderSocket.emit('sendMessage', {
  //     roomId: 'unauthorized-room',
  //     message: {
  //       sender: 'testSender',
  //       recipient: 'recipient123',
  //       messageBox: 'testBox',
  //       messageId: 'websocket-test-unauthorized',
  //       body: 'This should fail'
  //     }
  //   })

  //   // Since the server does not allow unauthorized room messages, we wait to see if nothing happens
  //   await new Promise((resolve) => setTimeout(resolve, 2000))
  // })
})
