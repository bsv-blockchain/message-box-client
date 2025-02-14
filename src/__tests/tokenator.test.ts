/* eslint-env jest */
import Tokenator from '../tokenator'
import { WalletClient } from '@bsv/sdk'

// ✅ Mock @bsv/sdk to ensure `AuthFetch` and `WalletClient` are properly handled
jest.mock('@bsv/sdk', () => ({
  AuthFetch: jest.fn().mockImplementation(() => ({
    fetch: jest.fn().mockResolvedValue({ json: async () => ({}) })
  })),
  WalletClient: jest.fn().mockImplementation(() => ({
    createHmac: jest.fn().mockResolvedValue({ hmac: new Uint8Array([1, 2, 3]) })
  }))
}))

describe('Tokenator', () => {
  let mockWalletClient: WalletClient = new WalletClient()

  beforeEach(() => {
    mockWalletClient = new WalletClient() // ✅ Provide a valid WalletClient instance
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  const VALID_SEND_RESULT = {
    body: JSON.stringify({
      status: 200,
      message: 'Your message has been sent!'
    })
  }

  const VALID_LIST_AND_READ_RESULT = {
    body: JSON.stringify({
      status: 200,
      messages: [
        {
          sender: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
          messageBoxId: 42,
          body: '{}'
        },
        {
          sender: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
          messageBoxId: 43,
          body: '{}'
        }
      ]
    })
  }

  const VALID_ACK_RESULT = {
    body: JSON.stringify({
      status: 200,
      message: 'Messages marked as acknowledged!'
    })
  }

  it('Creates an instance of the Tokenator class', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    const expectedInstance = {
      peerServHost: 'https://staging-peerserv.babbage.systems',
      joinedRooms: []
    }

    expect(JSON.parse(JSON.stringify(tokenator))).toMatchObject(expectedInstance)
  }, 100000)

  it('Throws an error if a message does not contain a recipient', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    await expect(tokenator.sendMessage({
      messageBox: 'test_inbox',
      body: {}
    } as any)).rejects.toThrow('You must provide a message recipient!')
  }, 100000)

  it('Throws an error if a message does not contain a messageBox', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    await expect(tokenator.sendMessage({
      recipient: 'mockIdentityKey',
      body: {}
    } as any)).rejects.toThrow('You must provide a messageBox to send this message into!')
  })

  it('Throws an error if a message does not contain a body', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    await expect(tokenator.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox'
    } as any)).rejects.toThrow('Every message must have a body!')
  })

  it('Sends a message', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    jest.spyOn(tokenator.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_SEND_RESULT.body),
      headers: new Headers(),
      ok: true,
      redirected: false,
      status: 200,
      statusText: 'OK',
      type: 'basic',
      url: '',
      clone: jest.fn(),
      body: null,
      bodyUsed: false,
      arrayBuffer: jest.fn(),
      blob: jest.fn(),
      formData: jest.fn(),
      text: jest.fn()
    } as unknown as Response)

    const result = await tokenator.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: { data: 'test' }
    })

    expect(result).toHaveProperty('message', 'Your message has been sent!')
  })

  it('Lists available messages', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    jest.spyOn(tokenator.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_LIST_AND_READ_RESULT.body),
      headers: new Headers(),
      ok: true,
      redirected: false,
      status: 200,
      statusText: 'OK',
      type: 'basic',
      url: '',
      clone: jest.fn(),
      body: null,
      bodyUsed: false,
      arrayBuffer: jest.fn(),
      blob: jest.fn(),
      formData: jest.fn(),
      text: jest.fn()
    } as unknown as Response)

    const result = await tokenator.listMessages({
      messageBox: 'test_inbox'
    })

    expect(result).toEqual(JSON.parse(VALID_LIST_AND_READ_RESULT.body).messages)
  })

  it('Acknowledges a message', async () => {
    const tokenator = new Tokenator({ walletClient: mockWalletClient })
    jest.spyOn(tokenator.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_ACK_RESULT.body),
      headers: new Headers(),
      ok: true,
      redirected: false,
      status: 200,
      statusText: 'OK',
      type: 'basic',
      url: '',
      clone: jest.fn(),
      body: null,
      bodyUsed: false,
      arrayBuffer: jest.fn(),
      blob: jest.fn(),
      formData: jest.fn(),
      text: jest.fn()
    } as unknown as Response)

    const result = await tokenator.acknowledgeMessage({
      messageIds: [42]
    })

    expect(result).toEqual(200)
  })
})
