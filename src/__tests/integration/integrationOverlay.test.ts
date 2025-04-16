/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

const MESSAGEBOX_HOST = 'http://localhost:5001' // MessageBoxServer running

const walletA = new WalletClient('json-api', 'localhost')
const walletB = new WalletClient('json-api', 'localhost')

const clientA = new MessageBoxClient({
  host: MESSAGEBOX_HOST,
  walletClient: walletA,
  overlayEnabled: true,
  networkPreset: 'local',
  enableLogging: true
})

const clientB = new MessageBoxClient({
  host: MESSAGEBOX_HOST,
  walletClient: walletB,
  overlayEnabled: true,
  networkPreset: 'local',
  enableLogging: true
})

let identityKeyA: string
let identityKeyB: string

beforeAll(async () => {
  identityKeyA = (await walletA.getPublicKey({ identityKey: true })).publicKey
  identityKeyB = (await walletB.getPublicKey({ identityKey: true })).publicKey
  await clientA.initializeConnection()
  await clientB.initializeConnection()
})

afterAll(async () => {
  await clientA.disconnectWebSocket()
  await clientB.disconnectWebSocket()
})

describe('Overlay Integration Tests', () => {
  const selfBox = 'overlay_self_box'
  const peerBox = 'forwarded_overlay_box'

  test('clientA broadcasts overlay advertisement', async () => {
    const result = await clientA.anointHost(MESSAGEBOX_HOST)
    expect(result).toHaveProperty('txid')
    await new Promise(resolve => setTimeout(resolve, 3000))
  })

  test('clientA resolves own host via overlay', async () => {
    const resolved = await (clientA as any).resolveHostForRecipient(identityKeyA)
    expect(resolved).toBe(MESSAGEBOX_HOST)
  })

  test('clientA sends message to self via overlay', async () => {
    const response = await clientA.sendMessage({
      recipient: identityKeyA,
      messageBox: selfBox,
      body: 'hello via overlay'
    })
    expect(response.status).toBe('success')
  })

  test('clientA lists self messages via overlay', async () => {
    const messages = await clientA.listMessages({ messageBox: selfBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.at(-1)?.body).toContain('hello via overlay')
  })

  test('clientA acknowledges self messages via overlay', async () => {
    const messages = await clientA.listMessages({ messageBox: selfBox })
    const ids = messages.map(m => m.messageId).filter(Boolean)
    expect(ids.length).toBeGreaterThan(0)
    const status = await clientA.acknowledgeMessage({ messageIds: ids })
    expect(status).toBe('success')
  })

  test('clientB broadcasts overlay advertisement', async () => {
    const result = await clientB.anointHost(MESSAGEBOX_HOST)
    expect(result).toHaveProperty('txid')
    await new Promise(resolve => setTimeout(resolve, 3000))
  })

  test('clientA sends message to clientB via overlay', async () => {
    const response = await clientA.sendMessage({
      recipient: identityKeyB,
      messageBox: peerBox,
      body: 'delivered to peer via overlay'
    })
    expect(response.status).toBe('success')
  })

  test('clientB receives overlay message from clientA', async () => {
    const messages = await clientB.listMessages({ messageBox: peerBox })
    expect(messages.some(m => m.body.includes('delivered to peer via overlay'))).toBe(true)
  })
})
