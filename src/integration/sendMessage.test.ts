import { AuthFetch, WalletClient } from '@bsv/sdk'

const serverUrl = 'http://localhost:4000'
const walletClient = new WalletClient() // Corrected import
const authFetch = new AuthFetch(walletClient)

describe('MessageBoxClient Integration - sendMessage', () => {
  it('should send a message successfully', async () => {
    const res = await authFetch.fetch(`${serverUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
          messageBox: 'testBox',
          messageId: 'test123',
          body: 'Hello, integration test!'
        }
      })
    })

    const parsedRes = await res.json()
    expect(parsedRes.status).toBe('success')
  })
})
