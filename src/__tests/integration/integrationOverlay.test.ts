/* eslint-env jest */
import { MessageBoxClient } from '../../MessageBoxClient.js'
import { WalletClient } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

// const OVERLAY_HOST = 'http://localhost:8080' // LARS running MessageBoxTopicManager
const MESSAGEBOX_HOST = 'http://localhost:5001' // MessageBoxServer

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
  test('broadcast advertisement for identity A', async () => {
    await clientA.anointHost(MESSAGEBOX_HOST)
    await new Promise(resolve => setTimeout(resolve, 3000)) // allow propagation
  })

  test('clientA resolves overlay host for identity A', async () => {
    const resolved = await (clientA as any).resolveHostForRecipient(identityKeyA)
    expect(resolved).toBe(MESSAGEBOX_HOST)
  })

  test('send message from clientA to self using overlay', async () => {
    const messageBox = 'overlay_self_box'
    const body = 'hello via overlay'

    const response = await clientA.sendMessage({
      recipient: identityKeyA,
      messageBox,
      body
    })

    expect(response.status).toBe('success')
  })

  test('list messages via overlay', async () => {
    const messageBox = 'overlay_self_box'
    const messages = await clientA.listMessages({ messageBox })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.at(-1)?.body).toContain('hello via overlay')
  })

  test('acknowledge messages via overlay', async () => {
    const messages = await clientA.listMessages({ messageBox: 'overlay_self_box' })
    const ids = messages.map(m => m.messageId).filter(id => typeof id === 'string')
    expect(ids.length).toBeGreaterThan(0)

    const status = await clientA.acknowledgeMessage({ messageIds: ids })
    expect(status).toBe('success')
  })

  test('broadcast advertisement for identity B', async () => {
    await clientB.anointHost(MESSAGEBOX_HOST)
    await new Promise(resolve => setTimeout(resolve, 3000))
  })

  test('send message from clientA to clientB via overlay', async () => {
    const messageBox = 'forwarded_overlay_box'
    const body = 'delivered to peer via overlay'

    const response = await clientA.sendMessage({
      recipient: identityKeyB,
      messageBox,
      body
    })

    expect(response.status).toBe('success')
  })

  test('clientB receives message sent via overlay', async () => {
    const messageBox = 'forwarded_overlay_box'
    const messages = await clientB.listMessages({ messageBox })
    expect(messages.some(m => m.body.includes('delivered to peer via overlay'))).toBe(true)
  })
})
