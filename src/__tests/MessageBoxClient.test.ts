/* eslint-env jest */
import { MessageBoxClient } from '../MessageBoxClient'
import { WalletClient, AuthFetch } from '@bsv/sdk'

// --- ✅ MOCK: WalletClient methods ---
jest.spyOn(WalletClient.prototype, 'createHmac').mockResolvedValue({
  hmac: Array.from(new Uint8Array([1, 2, 3]))
})

jest.spyOn(WalletClient.prototype, 'getPublicKey').mockResolvedValue({
  publicKey: 'mockIdentityKey'
})

// --- ✅ MOCK: AuthFetch responses ---
const defaultMockResponse: Partial<Response> = {
  json: async () => ({ status: 'success', message: 'Mocked response' }),
  headers: new Headers(),
  ok: true,
  status: 200
}

jest.spyOn(AuthFetch.prototype, 'fetch')
  .mockResolvedValue(defaultMockResponse as Response)

const socketOnMap: Record<string, (...args: any[]) => void> = {}

const mockSocket = {
  on: jest.fn((event, callback) => {
    socketOnMap[event] = callback
  }),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connected: true,
  off: jest.fn()
}

jest.mock('@bsv/authsocket-client', () => ({
  AuthSocketClient: jest.fn(() => mockSocket)
}))



// Optional: Global WebSocket override (not strictly needed with AuthSocketClient)
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  on = jest.fn()
  send = jest.fn()
  close = jest.fn()
}
global.WebSocket = MockWebSocket as unknown as typeof WebSocket

describe('MessageBoxClient', () => {
  let mockWalletClient: WalletClient

  beforeEach(() => {
    mockWalletClient = new WalletClient()
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
        { sender: 'mockSender', messageBoxId: 42, body: '{}' },
        { sender: 'mockSender', messageBoxId: 43, body: '{}' }
      ]
    })
  }

  const VALID_ACK_RESULT = {
    body: JSON.stringify({
      status: 200,
      message: 'Messages marked as acknowledged!'
    })
  }

  it('Creates an instance of the MessageBoxClient class', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      enableLogging: true
    })

    expect(messageBoxClient).toHaveProperty('host', 'https://messagebox.babbage.systems')

    // Ensure the socket is initialized as undefined before connecting
    expect(messageBoxClient.testSocket).toBeUndefined()
  })

  it('Initializes WebSocket connection', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))

    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      enableLogging: true
    })

    const connection = messageBoxClient.initializeConnection()

    // Simulate server response
    setTimeout(() => {
      socketOnMap['authenticationSuccess']?.({ status: 'ok' })
    }, 100)

    await expect(connection).resolves.toBeUndefined()
  }, 10000)

  it('Falls back to HTTP when WebSocket is not initialized', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    // Bypass the real connection logic
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => { })

      // Manually set identity key
      ; (messageBoxClient as any).myIdentityKey = 'mockIdentityKey'

      // Simulate WebSocket not initialized
      ; (messageBoxClient as any).socket = null

    // Expect it to fall back to HTTP and succeed
    const result = await messageBoxClient.sendLiveMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: 'Test message'
    })

    expect(result).toEqual({
      status: 'success',
      message: 'Mocked response',
      messageId: '010203'
    })
  })

  it('Listens for live messages', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    const connection = messageBoxClient.initializeConnection()

    setTimeout(() => {
      socketOnMap['authenticationSuccess']?.({ status: 'ok' })
    }, 100)

    await connection

    const mockOnMessage = jest.fn()

    await messageBoxClient.listenForLiveMessages({
      messageBox: 'test_inbox',
      onMessage: mockOnMessage
    })

    expect(messageBoxClient.testSocket?.emit).toHaveBeenCalledWith(
      'joinRoom',
      'mockIdentityKey-test_inbox'
    )
  }, 10000)

  it('Sends a live message', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    const connection = messageBoxClient.initializeConnection()

    // Simulate WebSocket auth success
    setTimeout(() => {
      socketOnMap['authenticationSuccess']?.({ status: 'ok' })
    }, 100)

    await connection

    const emitSpy = jest.spyOn(messageBoxClient.testSocket as any, 'emit')

    // Kick off sending a message (this sets up the ack listener)
    const sendPromise = messageBoxClient.sendLiveMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: 'Test message'
    })

    // Simulate WebSocket acknowledgment
    setTimeout(() => {
      socketOnMap['sendMessageAck-mockIdentityKey-test_inbox']?.({
        status: 'success',
        messageId: 'mocked123'
      })
    }, 100)

    const result = await sendPromise

    // Check that WebSocket emit happened correctly
    expect(emitSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        roomId: 'mockIdentityKey-test_inbox',
        message: expect.objectContaining({ body: 'Test message' })
      })
    )

    // Check the resolved result
    expect(result).toEqual({
      status: 'success',
      messageId: 'mocked123'
    })
  }, 15000)

  it('Sends a message', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })
    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => ({
        status: 'success',
        message: 'Your message has been sent!'
      }),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)


    const result = await messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: { data: 'test' }
    })

    expect(result).toHaveProperty('message', 'Your message has been sent!')
  })

  it('Lists available messages', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })
    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_LIST_AND_READ_RESULT.body),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)

    const result = await messageBoxClient.listMessages({ messageBox: 'test_inbox' })

    expect(result).toEqual(JSON.parse(VALID_LIST_AND_READ_RESULT.body).messages)
  })

  it('Acknowledges a message', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })
    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_ACK_RESULT.body),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)

    const result = await messageBoxClient.acknowledgeMessage({ messageIds: ['42'] })

    expect(result).toEqual(200)
  })

  it('Throws an error when sendMessage() API fails', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    jest.spyOn(messageBoxClient.authFetch, 'fetch')
      .mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        ok: false,
        json: async () => ({ status: 'error', description: 'Internal Server Error' }),
        headers: new Headers()
      } as unknown as Response)

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: 'Test Message'
    })).rejects.toThrow('Message sending failed: HTTP 500 - Internal Server Error')
  })

  it('Throws an error when listMessages() API fails', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    jest.spyOn(messageBoxClient.authFetch, 'fetch')
      .mockResolvedValue({
        status: 500,
        json: async () => ({ status: 'error', description: 'Failed to fetch messages' })
      } as unknown as Response)

    await expect(messageBoxClient.listMessages({ messageBox: 'test_inbox' }))
      .rejects.toThrow('Failed to fetch messages')
  })

  it('Throws an error when acknowledgeMessage() API fails', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    jest.spyOn(messageBoxClient.authFetch, 'fetch')
      .mockResolvedValue({
        status: 500,
        json: async () => ({ status: 'error', description: 'Failed to acknowledge messages' })
      } as unknown as Response)

    await expect(messageBoxClient.acknowledgeMessage({ messageIds: ['42'] }))
      .rejects.toThrow('Failed to acknowledge messages')
  })

  it('Throws an error when identity key is missing', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    // Mock `getPublicKey` to return an empty key
    jest.spyOn(mockWalletClient, 'getPublicKey').mockResolvedValue({ publicKey: '' })

    await expect(messageBoxClient.initializeConnection()).rejects.toThrow('Identity key is missing')
  })

  it('Throws an error when WebSocket is not initialized before listening for messages', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

      // Stub out the identity key to pass that check
      ; (messageBoxClient as any).myIdentityKey = 'mockIdentityKey'

    // Stub out joinRoom to throw like the real one might
    jest.spyOn(messageBoxClient, 'joinRoom').mockRejectedValue(new Error('WebSocket connection not initialized'))

    await expect(
      messageBoxClient.listenForLiveMessages({
        onMessage: jest.fn(),
        messageBox: 'test_inbox'
      })
    ).rejects.toThrow('WebSocket connection not initialized')
  })

  it('Emits joinRoom event and listens for incoming messages', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    // Mock identity key properly
    jest.spyOn(mockWalletClient, 'getPublicKey').mockResolvedValue({ publicKey: 'mockIdentityKey' })

    // Mock socket with `on` method capturing event handlers
    const mockSocket = {
      emit: jest.fn(),
      on: jest.fn()
    } as any

    // Mock `initializeConnection` so it assigns `socket` & identity key
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => {
      Object.defineProperty(messageBoxClient, 'testIdentityKey', { get: () => 'mockIdentityKey' })
      Object.defineProperty(messageBoxClient, 'testSocket', { get: () => mockSocket });
      (messageBoxClient as any).socket = mockSocket; // Ensures internal socket is set
      (messageBoxClient as any).myIdentityKey = 'mockIdentityKey' // Ensures identity key is set
    })

    const onMessageMock = jest.fn()

    await messageBoxClient.listenForLiveMessages({
      onMessage: onMessageMock,
      messageBox: 'test_inbox'
    })

    // Ensure `joinRoom` event was emitted with the correct identity key
    expect(mockSocket.emit).toHaveBeenCalledWith('joinRoom', 'mockIdentityKey-test_inbox')

    // Simulate receiving a message
    const receivedMessage = { text: 'Hello, world!' }

    // Extract & invoke the callback function stored in `on`
    const sendMessageCallback = mockSocket.on.mock.calls.find(
      ([eventName]) => eventName === 'sendMessage-mockIdentityKey-test_inbox'
    )?.[1] // Extract the callback function

    if (typeof sendMessageCallback === 'function') {
      sendMessageCallback(receivedMessage)
    }

    // Ensure `onMessage` was called with the received message
    expect(onMessageMock).toHaveBeenCalledWith(receivedMessage)
  })

  it('Handles WebSocket connection and disconnection events', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    // Simulate identity key
    jest.spyOn(mockWalletClient, 'getPublicKey').mockResolvedValue({ publicKey: 'mockIdentityKey' })

    // Simulate connection + disconnection + auth success
    setTimeout(() => {
      socketOnMap['connect']?.()
      socketOnMap['disconnect']?.()
      socketOnMap['authenticationSuccess']?.({ status: 'ok' })
    }, 100)

    await messageBoxClient.initializeConnection()

    // Verify event listeners were registered
    expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function))
    expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function))
  }, 10000)

  it('throws an error when recipient is empty in sendLiveMessage', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    // Mock `initializeConnection` so it assigns `socket` & identity key
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => {
      Object.defineProperty(messageBoxClient, 'testIdentityKey', { get: () => 'mockIdentityKey' })
      Object.defineProperty(messageBoxClient, 'testSocket', { get: () => mockSocket });
      (messageBoxClient as any).socket = mockSocket; // Ensures internal socket is set
      (messageBoxClient as any).myIdentityKey = 'mockIdentityKey' // Ensures identity key is set
    })

    // Mock socket to ensure WebSocket validation does not fail
    const mockSocket = {
      emit: jest.fn()
    } as any
    jest.spyOn(messageBoxClient, 'testSocket', 'get').mockReturnValue(mockSocket)

    await expect(messageBoxClient.sendLiveMessage({
      recipient: '  ',
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('[MB CLIENT ERROR] Recipient identity key is required')
  })

  it('throws an error when recipient is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    await expect(messageBoxClient.sendMessage({
      recipient: '', // Empty recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')

    await expect(messageBoxClient.sendMessage({
      recipient: '   ', // Whitespace recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')

    await expect(messageBoxClient.sendMessage({
      recipient: null as any, // Null recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')
  })

  it('throws an error when messageBox is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: '', // Empty messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: '   ', // Whitespace messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: null as any, // Null messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')
  })

  it('throws an error when message body is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: '' // Empty body
    })).rejects.toThrow('Every message must have a body!')

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: '   ' // Whitespace body
    })).rejects.toThrow('Every message must have a body!')

    await expect(messageBoxClient.sendMessage({
      recipient: 'mockIdentityKey',
      messageBox: 'test_inbox',
      body: null as any // Null body
    })).rejects.toThrow('Every message must have a body!')
  })

  it('throws an error when messageBox is empty in listMessages', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    await expect(messageBoxClient.listMessages({
      messageBox: '' // Empty messageBox
    })).rejects.toThrow('MessageBox cannot be empty')

    await expect(messageBoxClient.listMessages({
      messageBox: '   ' // Whitespace messageBox
    })).rejects.toThrow('MessageBox cannot be empty')
  })

  it('throws an error when messageIds is empty in acknowledgeMessage', async () => {
    const messageBoxClient = new MessageBoxClient({ walletClient: mockWalletClient })

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: [] // Empty array
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: undefined as any // Undefined value
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: null as any // Null value
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: 'invalid' as any // Not an array
    })).rejects.toThrow('Message IDs array cannot be empty')
  })
})
