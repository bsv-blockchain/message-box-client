import { AuthSocketClient } from '@bsv/authsocket'
import { WalletClient } from '@bsv/sdk'

// Ensure `NODE_ENV=test` is used for tests
process.env.NODE_ENV = 'test'

// Mock wallet client if needed
jest.mock('@bsv/sdk', () => {
  return {
    WalletClient: jest.fn().mockImplementation(() => ({
      getPublicKey: jest.fn(async () => ({
        publicKey: 'test-public-key'
      })),
      createHmac: jest.fn(async () => ({
        hmac: new Uint8Array([1, 2, 3, 4])
      }))
    }))
  }
})

let socket: ReturnType<typeof AuthSocketClient> | undefined

beforeAll(async () => {
  console.log('Initializing WebSocket connection for tests...')
  socket = AuthSocketClient('http://localhost:4000', {
    wallet: new WalletClient()
  })

  await new Promise(resolve => {
    socket?.on('connect', resolve)
  })
})

afterAll(() => {
  if (socket !== null && socket !== undefined) {
    socket.disconnect()
    console.log('Closed WebSocket connection')
  }
})
