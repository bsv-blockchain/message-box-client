import MessageBoxClient, { PeerServMessage } from '../../MessageBoxClient'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

const WS_URL = 'https://messagebox.babbage.systems'

let recipientKey: string
const messageBox = 'testBox'
const testMessage = 'Hello, this is a WebSocket integration test.'

const walletClient = new WalletClient('json-api', 'localhost')
const messageBoxClient = new MessageBoxClient({
  peerServHost: WS_URL,
  walletClient
})

describe('MessageBoxClient WebSocket Integration Tests', () => {
  beforeAll(async () => {
    // console.log('Initializing WebSocket connection for tests...')
    // await messageBoxClient.initializeConnection()
    // console.log('WebSocket connection initialized.')

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
    await messageBoxClient.initializeConnection()
    expect(messageBoxClient).toBeDefined()
    console.log('[TEST] WebSocket authenticated and connected')
  }, 15000)

  /** TEST 2: Join a WebSocket Room **/
  test('should join a WebSocket room successfully', async () => {
    await messageBoxClient.joinRoom(messageBox)
    console.log(`Joined WebSocket room: ${messageBox}`)

    // Verify that the room was actually joined
    expect(messageBoxClient.getJoinedRooms().has(`${messageBoxClient.getIdentityKey()}-${messageBox}`)).toBe(true)
  })

  /** TEST 3: Send and Receive a Message via WebSocket **/
  /** TEST 3: Send and Receive a Message via WebSocket **/
  test(
    'should send and receive a message via WebSocket',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      let receivedMessage: PeerServMessage | null = null

      // Create a promise to wait for the received message
      const messagePromise: Promise<PeerServMessage> = new Promise(
        (resolve, reject) => {
          messageBoxClient
            .listenForLiveMessages({
              messageBox,
              onMessage: (message: PeerServMessage) => {
                try {
                  receivedMessage = message
                  console.log(
                    '[TEST] Received message:',
                    JSON.stringify(message, null, 2)
                  )
                  resolve(message)
                } catch (error) {
                  console.error('[ERROR] Error processing message:', error)
                  reject(error)
                }
              }
            })
            .catch(reject) // Handle potential listener setup errors

          setTimeout(
            () =>
              reject(
                new Error('Test timed out: No message received over WebSocket')
              ),
            10000
          )
        }
      )

      // Ensure WebSocket room is joined before sending
      await messageBoxClient.joinRoom(messageBox)

      console.log(`[TEST] Sending message to WebSocket room: ${messageBox}`)

      // Send the message via WebSocket
      const response = await messageBoxClient.sendLiveMessage({
        recipient: recipientKey,
        messageBox,
        body: testMessage
      })

      // Ensure message sending was successful
      expect(response).toHaveProperty('status', 'success')

      // Wait for the received message
      const received: PeerServMessage = await messagePromise

      // Validate received message
      expect(received).not.toBeNull()
      expect(received.body).toBe(testMessage)
      expect(received.sender).toBe(recipientKey)
    },
    15000
  )

  /** TEST 4: Leave a WebSocket Room **/
  test('should leave a WebSocket room successfully', async () => {
    await messageBoxClient.leaveRoom(messageBox)
    console.log(`[TEST] Left WebSocket room: ${messageBox}`)

    // Ensure the room is removed from joinedRooms
    expect(messageBoxClient.getJoinedRooms().has(`${messageBoxClient.getIdentityKey()}-${messageBox}`)).toBe(false)
  })
})
