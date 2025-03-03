import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

const WS_URL = 'ws://localhost:8080'

let recipientKey: string
let testMessageId: string
const messageBox = 'testBox'
const testMessage = 'Hello, this is a WebSocket integration test.'

const walletClient = new WalletClient('json-api', 'localhost')
const messageBoxClient = new MessageBoxClient({
  peerServHost: WS_URL,
  walletClient
})

describe('MessageBoxClient WebSocket Integration Tests', () => {
  beforeAll(async () => {
    console.log('Initializing WebSocket connection for tests...')
    await messageBoxClient.initializeConnection()
    console.log('WebSocket connection initialized.')

    const keyResult = await walletClient.getPublicKey({ identityKey: true })
    recipientKey = keyResult.publicKey
    console.log(`Recipient Key: ${recipientKey}`)
  })

  afterAll(async () => {
    console.log('Closing WebSocket connection after tests.')
    await messageBoxClient.disconnectWebSocket() // Use the new method
  })

  /** TEST 1: Authenticate WebSocket Connection **/
  test('should authenticate and connect via WebSocket', async () => {
    expect(messageBoxClient).toBeDefined()
  })

  /** TEST 2: Join a WebSocket Room **/
  test('should join a WebSocket room successfully', async () => {
    await messageBoxClient.joinRoom(messageBox)
    console.log(`Joined WebSocket room: ${messageBox}`)
  })

  /** TEST 3: Send a Message via WebSocket **/
  test('should send a message via WebSocket', async () => {
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage
    })

    expect(response.status).toBe('success')
    testMessageId = response.messageId
    console.log(`Sent WebSocket message with ID: ${testMessageId}`)
  })

  /** TEST 4: Leave a WebSocket Room **/
  test('should leave a WebSocket room successfully', async () => {
    await messageBoxClient.leaveRoom(messageBox)
    console.log(`Left WebSocket room: ${messageBox}`)
  })
})
