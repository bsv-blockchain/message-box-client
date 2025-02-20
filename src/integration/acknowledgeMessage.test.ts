import { startTestServer, stopTestServer } from './testServer.js'
import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'

describe('Integration Test: acknowledgeMessage', () => {
  let client: MessageBoxClient
  const testRecipient = '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'
  const testMessageBox = 'testBox'

  beforeAll(async () => {
    await startTestServer()
    client = new MessageBoxClient({
      walletClient: new WalletClient()
    })
  })

  afterAll(async () => {
    await stopTestServer()
  })

  it('should acknowledge a message successfully', async () => {
    // Step 1: Send a message
    const sentMessage = await client.sendMessage({
      recipient: testRecipient,
      messageBox: testMessageBox,
      body: 'This is a test message'
    })

    expect(sentMessage.status).toBe('success')

    // Step 2: List messages to retrieve the message ID
    const messages = await client.listMessages({ messageBox: testMessageBox })
    expect(messages).toBeInstanceOf(Array)
    expect(messages.length).toBeGreaterThan(0)

    // Step 3: Find the message we just sent
    const foundMessage = messages.find((msg) => String(msg.messageId) === String(sentMessage.messageId))
    expect(foundMessage).toBeDefined()
    expect(foundMessage?.body).toBe('This is a test message')

    // Step 4: Acknowledge the message
    if (foundMessage === null || foundMessage === undefined) {
      throw new Error('Message not found')
    }
    const acknowledgeResponse = await client.acknowledgeMessage({ messageIds: [foundMessage.messageId] })
    expect(acknowledgeResponse).toBe('success')

    // Step 5: Verify that the message is now acknowledged
    const updatedMessages = await client.listMessages({ messageBox: testMessageBox })
    const acknowledgedMessage = updatedMessages.find((msg) => String(msg.messageId) === String(sentMessage.messageId))

    expect(acknowledgedMessage).toBeDefined()
    expect(acknowledgedMessage?.acknowledged).toBe(true) // Ensure message is marked as acknowledged
  })

  it('should fail when acknowledging an invalid message ID', async () => {
    await expect(client.acknowledgeMessage({ messageIds: [999999] }))
      .rejects.toThrow('Message not found or already acknowledged')
  })
})
