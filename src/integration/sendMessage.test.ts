import { startTestServer, stopTestServer } from './testServer.js'
import MessageBoxClient from '../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'

describe('Integration Test: sendMessage (Payment Handling)', () => {
  let client: MessageBoxClient
  let wallet: WalletClient

  beforeAll(async () => {
    await startTestServer()
    wallet = new WalletClient()
    client = new MessageBoxClient({ peerServHost: 'http://localhost:3000', walletClient: wallet })
  })

  afterAll(async () => {
    await stopTestServer()
  })

  it('should send a message successfully after making payment', async () => {
    // Spy on the payment-related function
    const paymentSpy = jest.spyOn(wallet, 'createHmac').mockImplementation(async () => ({
      hmac: [1, 2, 3, 4] // Use a simple number array instead of Uint8Array
    }))

    const response = await client.sendMessage({
      recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
      messageBox: 'testBox',
      messageId: 'test123',
      body: 'Hello, integration test!'
    })

    expect(response.status).toBe('success')
    expect(response.messageId).toBe('test123')

    // Ensure payment was attempted
    expect(paymentSpy).toHaveBeenCalledTimes(1)
  })

  it('should fail when payment is missing', async () => {
    // Remove payment by preventing `createHmac` from returning anything
    jest.spyOn(wallet, 'createHmac').mockImplementation(async () => {
      throw new Error('Payment failure')
    })

    await expect(client.sendMessage({
      recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
      messageBox: 'testBox',
      messageId: 'test123',
      body: 'Hello, integration test!'
    })).rejects.toThrow('Payment failure')
  })

  it('should fail when sending a message with missing fields', async () => {
    await expect(client.sendMessage({
      recipient: '',
      messageBox: 'testBox',
      body: 'This should fail'
    })).rejects.toThrow('You must provide a message recipient!')
  })

  it('should fail when missing messageBox', async () => {
    await expect(client.sendMessage({
      recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
      messageBox: '',
      body: 'This should fail'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')
  })

  it('should fail when sending an empty body', async () => {
    await expect(client.sendMessage({
      recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
      messageBox: 'testBox',
      body: ''
    })).rejects.toThrow('Every message must have a body!')
  })
})
