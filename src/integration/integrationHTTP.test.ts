import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'

const walletClient = new WalletClient()
const messageBoxClient = new MessageBoxClient({
  peerServHost: 'http://localhost:4000',
  walletClient
})

describe('MessageBoxClient HTTP Integration Tests', () => {
  let recipientKey: string
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let senderKey: string
  let testMessageId: string
  const messageBox = 'testBox'
  const testMessage = 'Hello, this is an integration test.'

  beforeAll(async () => {
    const recipient = await walletClient.getPublicKey({ identityKey: true })
    const sender = await walletClient.getPublicKey({ identityKey: true })

    recipientKey = recipient.publicKey
    senderKey = sender.publicKey
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
  })

  /** TEST 2: Send Message without Payment (Expect 402) **/
  test('should fail to send a message without payment', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('Payment is required before sending messages.')
  })

  /** TEST 3: List Messages **/
  test('should list messages from messageBox', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0].body).toBe(JSON.stringify(testMessage))
  })

  /** TEST 4: List Messages from an Empty MessageBox **/
  test('should return an empty list if no messages exist', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox: 'emptyBox' })
    expect(messages).toEqual([])
  })

  /** TEST 5: Acknowledge a Message **/
  test('should acknowledge (delete) a message', async () => {
    const ackResponse = await messageBoxClient.acknowledgeMessage({ messageIds: [testMessageId] })
    expect(ackResponse).toBe('success')
  })

  /** TEST 6: Acknowledge a Nonexistent Message **/
  test('should fail to acknowledge a nonexistent message', async () => {
    await expect(
      messageBoxClient.acknowledgeMessage({ messageIds: ['fakeMessageId'] })
    ).rejects.toThrow('Message not found!')
  })

  /** TEST 7: Send Message with Invalid Recipient **/
  test('should fail if recipient is invalid', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: '', // Invalid recipient
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('Recipient must be a compressed public key formatted as a hex string!')
  })

  /** TEST 8: Send Message with Empty Body **/
  test('should fail if message body is empty', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: '' // Empty message
      })
    ).rejects.toThrow('Every message must have a body!')
  })
})
