/* eslint-env jest */
import { PeerPayClient } from '../PeerPayClient.js'
import { WalletClient, CreateHmacResult, PrivateKey } from '@bsv/sdk'
import { jest } from '@jest/globals'

const toArray = (msg: any, enc?: 'hex' | 'utf8' | 'base64'): any[] => {
  if (Array.isArray(msg)) return msg.slice()
  if (msg === undefined) return []

  if (typeof msg !== 'string') {
    return Array.from(msg, (item: any) => item | 0)
  }

  switch (enc) {
    case 'hex': {
      const matches = msg.match(/.{1,2}/g)
      return matches != null ? matches.map(byte => parseInt(byte, 16)) : []
    }
    case 'base64':
      return Array.from(Buffer.from(msg, 'base64'))
    default:
      return Array.from(Buffer.from(msg, 'utf8'))
  }
}

// Mock dependencies
jest.mock('@bsv/sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actualSDK = jest.requireActual('@bsv/sdk') as any

  return {
    ...actualSDK,
    WalletClient: jest.fn().mockImplementation(() => ({
      getPublicKey: jest.fn(),
      createAction: jest.fn(),
      internalizeAction: jest.fn(),
      createHmac: jest.fn<() => Promise<CreateHmacResult>>().mockResolvedValue({
        hmac: [1, 2, 3, 4, 5]
      })
    }))
  }
})

describe('PeerPayClient Unit Tests', () => {
  let peerPayClient: PeerPayClient
  let mockWalletClient: jest.Mocked<WalletClient>

  beforeEach(() => {
    jest.clearAllMocks()

    mockWalletClient = new WalletClient() as jest.Mocked<WalletClient>

    // Ensure a valid compressed public key (33 bytes, hex format)
    mockWalletClient.getPublicKey.mockResolvedValue({
      publicKey: PrivateKey.fromRandom().toPublicKey().toString()
    })

    mockWalletClient.createAction.mockResolvedValue({
      tx: toArray('mockedTransaction', 'utf8')
    })

    peerPayClient = new PeerPayClient({
      messageBoxHost: 'https://messagebox.babbage.systems',
      walletClient: mockWalletClient
    })
  })

  describe('createPaymentToken', () => {
    it('should create a valid payment token', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({
        publicKey: PrivateKey.fromRandom().toPublicKey().toString()
      })
      mockWalletClient.createAction.mockResolvedValue({ tx: toArray('mockedTransaction', 'utf8') })

      const payment = { recipient: PrivateKey.fromRandom().toPublicKey().toString(), amount: 5 }
      const token = await peerPayClient.createPaymentToken(payment)

      expect(token).toHaveProperty('amount', 5)
      expect(mockWalletClient.getPublicKey).toHaveBeenCalledWith(expect.any(Object))
      expect(mockWalletClient.createAction).toHaveBeenCalledWith(expect.any(Object))
    })

    it('should throw an error if recipient public key cannot be derived', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({ publicKey: '' }) // Empty key

      await expect(peerPayClient.createPaymentToken({ recipient: 'invalid', amount: 5 }))
        .rejects.toThrow('Failed to derive recipient’s public key')
    })

    it('should throw an error if amount is <= 0', async () => {
      (mockWalletClient.getPublicKey as jest.MockedFunction<typeof mockWalletClient.getPublicKey>)
        .mockResolvedValue({
          publicKey: PrivateKey.fromRandom().toPublicKey().toString()
        })

      await expect(peerPayClient.createPaymentToken({
        recipient: PrivateKey.fromRandom().toPublicKey().toString(),
        amount: 0
      }))
        .rejects.toThrow('Invalid payment details: recipient and valid amount are required')
    })
  })

  // Test: sendPayment
  describe('sendPayment', () => {
    it('should call sendMessage with valid payment', async () => {
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const payment = { recipient: 'recipientKey', amount: 3 }

      console.log('[TEST] Calling sendPayment...')
      await peerPayClient.sendPayment(payment)
      console.log('[TEST] sendPayment finished.')

      expect(sendMessageSpy).toHaveBeenCalledWith({
        recipient: 'recipientKey',
        messageBox: 'payment_inbox',
        body: expect.any(String)
      })
    }, 10000)
  })

  // Test: sendLivePayment
  describe('sendLivePayment', () => {
    it('should call createPaymentToken and sendLiveMessage with correct parameters', async () => {
      jest.spyOn(peerPayClient, 'createPaymentToken').mockResolvedValue({
        customInstructions: {
          derivationPrefix: 'prefix',
          derivationSuffix: 'suffix'
        },
        transaction: Array.from(new Uint8Array([1, 2, 3, 4, 5])),
        amount: 2
      })

      jest.spyOn(peerPayClient, 'sendLiveMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const payment = { recipient: 'recipientKey', amount: 2 }
      await peerPayClient.sendLivePayment(payment)

      expect(peerPayClient.createPaymentToken).toHaveBeenCalledWith(payment)
      expect(peerPayClient.sendLiveMessage).toHaveBeenCalledWith({
        recipient: 'recipientKey',
        messageBox: 'payment_inbox',
        body: "{\"customInstructions\":{\"derivationPrefix\":\"prefix\",\"derivationSuffix\":\"suffix\"},\"transaction\":[1,2,3,4,5],\"amount\":2}"
      })
    })
  })

  // Test: acceptPayment
  describe('acceptPayment', () => {
    it('should call internalizeAction and acknowledgeMessage', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = {
        messageId: '123',
        sender: 'senderKey',
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 6
        }
      }

      await peerPayClient.acceptPayment(payment)

      expect(mockWalletClient.internalizeAction).toHaveBeenCalled()
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['123'] })
    })
  })

  // Test: rejectPayment
  describe('rejectPayment', () => {
    it('should refund payment minus fee', async () => {
      jest.spyOn(peerPayClient, 'acceptPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = {
        messageId: '123',
        sender: 'senderKey',
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 2000
        }
      }

      await peerPayClient.rejectPayment(payment)

      expect(peerPayClient.acceptPayment).toHaveBeenCalledWith(payment)
      expect(peerPayClient.sendPayment).toHaveBeenCalledWith({
        recipient: 'senderKey',
        amount: 1000 // Deduct satoshi fee
      })
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({
        messageIds: ['123']
      })
    })
  })

  // Test: listIncomingPayments
  describe('listIncomingPayments', () => {
    it('should return parsed payment messages', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: '1',
          sender: 'sender1',
          created_at: '2025-03-05T12:00:00Z',
          updated_at: '2025-03-05T12:05:00Z',
          body: JSON.stringify({
            customInstructions: { derivationPrefix: 'prefix1', derivationSuffix: 'suffix1' },
            transaction: toArray('mockedTransaction1', 'utf8'),
            amount: 3
          })
        },
        {
          messageId: '2',
          sender: 'sender2',
          created_at: '2025-03-05T12:10:00Z',
          updated_at: '2025-03-05T12:15:00Z',
          body: JSON.stringify({
            customInstructions: { derivationPrefix: 'prefix2', derivationSuffix: 'suffix2' },
            transaction: toArray('mockedTransaction2', 'utf8'),
            amount: 9
          })
        }
      ])

      const payments = await peerPayClient.listIncomingPayments()

      expect(payments).toHaveLength(2)
      expect(payments[0]).toHaveProperty('sender', 'sender1')
      expect(payments[0].token.amount).toBe(3)
      expect(payments[1]).toHaveProperty('sender', 'sender2')
      expect(payments[1].token.amount).toBe(9)
    })
  })
})
