import MessageBoxClient from '../MessageBoxClient'
import { WalletClient, PrivateKey } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

// Mock WalletClient correctly
const mockWalletClient: Partial<WalletClient> = {
  connectToSubstrate: jest.fn(async () => {
    console.log('Mocked: connectToSubstrate called')
    return undefined // Prevents real connection attempt
  }),

  getPublicKey: jest.fn(async (args: {
    identityKey?: true
    protocolID?: [number, string]
    keyID?: string
    privileged?: boolean
    privilegedReason?: string
    counterparty?: string
    forSelf?: boolean
  }) => {
    console.log('Mocked: getPublicKey called', args)

    if (args.identityKey === true) {
    // Generate a valid random private key and return its public key
      const privateKey = PrivateKey.fromRandom()
      const publicKeyHex = privateKey.toPublicKey().toString()

      console.log('Generated valid public key:', publicKeyHex)
      return { publicKey: publicKeyHex }
    }

    throw new Error('Invalid key request')
  }),

  createHmac: jest.fn(async (args: {
    data: number[]
    protocolID: [number, string]
    keyID: string
    privilegedReason?: string
    counterparty?: string
    privileged?: boolean
  }) => {
    console.log('Mocked: createHmac called', args)

    if (
      args.data === undefined || args.protocolID === undefined ||
      args.keyID === undefined || args.counterparty === undefined
    ) {
      throw new Error('Missing parameters for HMAC')
    }

    return {
      hmac: Array.from(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) // Ensure it's number[]
    }
  }),

  verifyHmac: jest.fn(async (args) => {
    console.log('Mocked: verifyHmac called', args)
    return { valid: true as const } // Always return valid HMAC for now
  }),

  verifySignature: jest.fn(async (args) => {
    console.log('Mocked: verifySignature called', args)
    return { valid: true as const } // Always return valid signature for now
  }),

  createSignature: jest.fn(async (args) => {
    console.log('Mocked: createSignature called', args)

    // Properly structured DER-encoded ECDSA signature
    const derSignature = [
      0x30, 0x44, // DER header (0x30 for sequence, 0x44 for length = 68 bytes)
      0x02, 0x20, // Marker for R integer (0x20 = 32 bytes)
      ...Array(32).fill(0x01), // Mocked R value (32 bytes)
      0x02, 0x20, // Marker for S integer (0x20 = 32 bytes)
      ...Array(32).fill(0x02) // Mocked S value (32 bytes)
    ]

    return { signature: derSignature }
  })

}

// ✅ Mock fetch so that AuthFetch doesn't make real requests
global.fetch = jest.fn(async (url: string, options) => {
  console.log(`Mocked fetch called for URL: ${url}`, options)
  if (String(url).includes('/sendMessage')) {
    return new Response(JSON.stringify({ status: 'success', messageId: 'testMessageIdMock' }), { status: 200 })
  }
  if (String(url).includes('/listMessages')) {
    return new Response(JSON.stringify({ messages: [{ body: JSON.stringify('Hello, this is an integration test.') }] }), { status: 200 })
  }
  if (String(url).includes('/acknowledgeMessage')) {
    return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
  }
  return new Response(JSON.stringify({ status: 'error', description: 'Mocked error' }), { status: 400 })
}) as jest.Mock

const messageBoxClient = new MessageBoxClient({
  peerServHost: 'http://localhost:8080',
  walletClient: mockWalletClient as WalletClient
})

describe('MessageBoxClient HTTP Integration Tests', () => {
  let recipientKey: string
  let testMessageId: string
  const messageBox = 'testBox'
  const testMessage = 'Hello, this is an integration test.'

  beforeAll(async () => {
    jest.spyOn(mockWalletClient, 'connectToSubstrate')
    jest.spyOn(mockWalletClient, 'getPublicKey')
    jest.spyOn(mockWalletClient, 'createHmac')

    recipientKey = 'testRecipientKey'
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
    global.fetch = jest.fn(async () => new Response(null, { status: 402 })) // Mock 402 response

    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('Payment is required before sending messages.')
  }, 10000)

  /** TEST 3: List Messages **/
  test('should list messages from messageBox', async () => {
    const messages = await messageBoxClient.listMessages({ messageBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages[0].body).toBe(JSON.stringify(testMessage))
  }, 10000)

  /** TEST 4: List Messages from an Empty MessageBox **/
  test('should return an empty list if no messages exist', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })) // Mock empty response

    const messages = await messageBoxClient.listMessages({ messageBox: 'emptyBox' })
    expect(messages).toEqual([])
  }, 10000)

  /** TEST 5: Acknowledge a Message **/
  test('should acknowledge (delete) a message', async () => {
    const ackResponse = await messageBoxClient.acknowledgeMessage({ messageIds: [testMessageId] })
    expect(ackResponse).toBe('success')
  }, 10000)

  /** TEST 6: Acknowledge a Nonexistent Message **/
  test('should fail to acknowledge a nonexistent message', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ status: 'error', description: 'Message not found!' }), { status: 404 }))

    await expect(
      messageBoxClient.acknowledgeMessage({ messageIds: ['fakeMessageId'] })
    ).rejects.toThrow('Message not found!')
  }, 10000)

  /** TEST 7: Send Message with Invalid Recipient **/
  test('should fail if recipient is invalid', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: '', // Invalid recipient
        messageBox,
        body: testMessage
      })
    ).rejects.toThrow('You must provide a message recipient!')
  }, 10000)

  /** TEST 8: Send Message with Empty Body **/
  test('should fail if message body is empty', async () => {
    await expect(
      messageBoxClient.sendMessage({
        recipient: recipientKey,
        messageBox,
        body: '' // Empty message
      })
    ).rejects.toThrow('Every message must have a body!')
  }, 10000)
})
