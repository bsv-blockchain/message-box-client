import { AuthSocketClient } from '@bsv/authsocket'
import { WalletClient } from '@bsv/sdk'

process.env.NODE_ENV = 'test'

jest.mock('@bsv/sdk', () => {
  const actualModule = jest.requireActual('@bsv/sdk')
  return {
    ...actualModule,
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
  const wallet = new WalletClient()

  try {
    socket = AuthSocketClient('http://localhost:8080', { wallet })

    await new Promise((resolve, reject) => {
      if (socket === undefined || socket === null) return reject(new Error('Socket was not initialized'))

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'))
      }, 10000) // Fail early after 10s if no connection

      socket.on('connect', () => {
        console.log('Connected to WebSocket')
        clearTimeout(timeout)
        resolve(undefined)
      })

      socket.on('connect_error', (err) => {
        console.error('WebSocket connect error:', err)
        clearTimeout(timeout)
        reject(err)
      })
    })
  } catch (error) {
    console.error('Error setting up WebSocket:', error)
    throw error
  }
})

afterAll(async () => {
  if (socket !== undefined && socket !== null) {
    console.log('Closing WebSocket connection...')
    socket.disconnect()
  }
})
