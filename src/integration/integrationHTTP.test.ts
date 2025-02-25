/* eslint-env jest */
import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

// Initialize WalletClient using Meta Net Client (MNC)
const walletClient = new WalletClient('auto')

// Initialize MessageBoxClient with the real wallet client
const messageBoxClient = new MessageBoxClient({
  peerServHost: 'http://localhost:8080',
  walletClient
})

describe('MessageBoxClient HTTP Integration Tests', () => {
  let recipientKey: string
  let testMessageId: string
  const messageBox = 'testBox'
  const testMessage = 'Hello, this is an integration test.'

  beforeAll(async () => {
    // Retrieve the recipient's public key
    const publicKeyResponse = await walletClient.getPublicKey({ identityKey: true })

    // Log the raw response
    console.log('[DEBUG] Raw getPublicKey Response:', publicKeyResponse)

    // Log the actual public key
    console.log('[DEBUG] Retrieved Public Key:', publicKeyResponse.publicKey)

    // Validate and assign recipientKey
    if (publicKeyResponse.publicKey === undefined || publicKeyResponse.publicKey === null || typeof publicKeyResponse.publicKey !== 'string' || publicKeyResponse.publicKey === '') {
      throw new Error('[ERROR] getPublicKey returned an invalid key!')
    }

    recipientKey = publicKeyResponse.publicKey
    console.log('[DEBUG] Assigned recipientKey:', recipientKey)
  })

  /** TEST 1: Send a Message with Payment **/
  test('should send a message successfully with payment', async () => {
    const response = await messageBoxClient.sendMessage({
      recipient: recipientKey,
      messageBox,
      body: testMessage
    })

    expect(response.status).toBe('success')
    testMessageId = response.messageId
  }, 15000)

  // /** TEST 2: Send Message without Payment (Expect 402) **/
  // test('should fail to send a message without payment', async () => {
  //   global.fetch = jest.fn(async () => new Response(null, { status: 402 })) // Mock 402 response

  //   await expect(
  //     messageBoxClient.sendMessage({
  //       recipient: recipientKey,
  //       messageBox,
  //       body: testMessage
  //     })
  //   ).rejects.toThrow('Payment is required before sending messages.')
  // }, 15000)

  // /** TEST 3: List Messages **/
  // test('should list messages from messageBox', async () => {
  //   const messages = await messageBoxClient.listMessages({ messageBox })
  //   expect(messages.length).toBeGreaterThan(0)
  //   expect(messages[0].body).toBe(JSON.stringify(testMessage))
  // }, 15000)

  // /** TEST 4: List Messages from an Empty MessageBox **/
  // test('should return an empty list if no messages exist', async () => {
  //   global.fetch = jest.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })) // Mock empty response

  //   const messages = await messageBoxClient.listMessages({ messageBox: 'emptyBox' })
  //   expect(messages).toEqual([])
  // }, 15000)

  // /** TEST 5: Acknowledge a Message **/
  // test('should acknowledge (delete) a message', async () => {
  //   const ackResponse = await messageBoxClient.acknowledgeMessage({ messageIds: [testMessageId] })
  //   expect(ackResponse).toBe('success')
  // }, 15000)

  // /** TEST 6: Acknowledge a Nonexistent Message **/
  // test('should fail to acknowledge a nonexistent message', async () => {
  //   global.fetch = jest.fn(async () => new Response(JSON.stringify({ status: 'error', description: 'Message not found!' }), { status: 404 }))

  //   await expect(
  //     messageBoxClient.acknowledgeMessage({ messageIds: ['fakeMessageId'] })
  //   ).rejects.toThrow('Message not found!')
  // }, 15000)

  // /** TEST 7: Send Message with Invalid Recipient **/
  // test('should fail if recipient is invalid', async () => {
  //   await expect(
  //     messageBoxClient.sendMessage({
  //       recipient: '', // Invalid recipient
  //       messageBox,
  //       body: testMessage
  //     })
  //   ).rejects.toThrow('You must provide a message recipient!')
  // }, 15000)

  // /** TEST 8: Send Message with Empty Body **/
  // test('should fail if message body is empty', async () => {
  //   await expect(
  //     messageBoxClient.sendMessage({
  //       recipient: recipientKey,
  //       messageBox,
  //       body: '' // Empty message
  //     })
  //   ).rejects.toThrow('Every message must have a body!')
  // }, 15000)
})
