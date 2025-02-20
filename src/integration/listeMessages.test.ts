import { startTestServer, stopTestServer } from './testServer.js'
import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'

describe('Integration Test: listMessages', () => {
  let client: MessageBoxClient
  const testMessageBox = 'testBox'
  const testRecipient = '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'

  beforeAll(async () => {
    await startTestServer()
    const wallet = new WalletClient()
    client = new MessageBoxClient({ peerServHost: 'http://localhost:8080', walletClient: wallet })
  })

  afterAll(async () => {
    await stopTestServer()
  })

  it('should return messages after one is sent', async () => {
    // Step 1: Send a message
    const sentMessage = await client.sendMessage({
      recipient: testRecipient,
      messageBox: testMessageBox,
      body: 'This is a test message'
    })

    expect(sentMessage.status).toBe('success')

    // Step 2: List messages
    const messages = await client.listMessages({ messageBox: testMessageBox })

    expect(messages).toBeInstanceOf(Array)
    expect(messages.length).toBeGreaterThan(0)

    // Step 3: Verify message content
    const foundMessage = messages.find((msg) => String(msg.messageId) === String(sentMessage.messageId))
    expect(foundMessage).toBeDefined()
    expect(foundMessage?.body).toBe('This is a test message')
  })

  it('should return an empty array when listing messages from an empty messageBox', async () => {
    const messages = await client.listMessages({ messageBox: 'emptyBox' })
    expect(messages).toBeInstanceOf(Array)
    expect(messages.length).toBe(0)
  })

  it('should handle unauthorized access properly', async () => {
    try {
      await client.listMessages({ messageBox: 'unauthorizedBox' })
    } catch (error: any) {
      expect(error.message).toMatch(/Unauthorized|403/)
    }
  })
})
