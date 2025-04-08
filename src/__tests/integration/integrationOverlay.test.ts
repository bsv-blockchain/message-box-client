import { MessageBoxClient, PeerMessage } from '../../MessageBoxClient.js'
import { WalletClient, PublicKey } from '@bsv/sdk'
import { webcrypto } from 'crypto'

(global as any).self = { crypto: webcrypto }

jest.setTimeout(20000)

const LOCAL_HOST = 'http://localhost:5001'
const OTHER_HOST = 'http://localhost:5002'

const walletClient = new WalletClient('json-api', 'localhost')
const client = new MessageBoxClient({
  host: LOCAL_HOST,
  walletClient,
  overlayEnabled: true
})

let identityKey: string

beforeAll(async () => {
    // 1. Get the identity key and initialize HMAC headers
    const { publicKey } = await walletClient.getPublicKey({ identityKey: true })
    identityKey = publicKey
  
    // 2. THIS STEP IS MISSING IN YOUR CURRENT TEST
    await client.initializeConnection()
  })
  
  

afterAll(async () => {
  await client.disconnectWebSocket()
})

describe('Overlay Integration Tests', () => {
  const testHost = LOCAL_HOST

  test('can anoint a host successfully', async () => {
    const result = await client.anointHost(testHost)
    expect(result).toBeUndefined()
  })

  test('can find host via /overlay/ads', async () => {
    const res = await fetch(`${LOCAL_HOST}/overlay/ads`)
    const { ads } = await res.json()

    const entry = ads.find((ad: any) => ad.identity_key === identityKey)
    expect(entry).toBeDefined()
    expect(entry?.host).toBe(testHost)
  })

  test('can send message and route via overlay', async () => {
    const messageBox = 'overlayTestBox'
    const messageText = 'Message routed via overlay'

    const response = await client.sendMessage({
      recipient: identityKey,
      messageBox,
      body: messageText
    })

    expect(response.status).toBe('success')
    expect(response.messageId).toBeDefined()
  })

  test('can list messages via overlay host', async () => {
    const messages = await client.listMessages({ messageBox: 'overlayTestBox' })
    expect(messages.length).toBeGreaterThan(0)

    const last = messages[messages.length - 1]
    expect(last.body).toContain('overlay')
    expect(last.sender).toBe(identityKey)
  })

  test('can acknowledge messages via overlay host', async () => {
    const messages = await client.listMessages({ messageBox: 'overlayTestBox' })
    const ids = messages.map(m => m.messageId).filter(id => typeof id === 'string')

    const status = await client.acknowledgeMessage({ messageIds: ids })
    expect(status).toBe(200)
  })

  test('can forward message to remote overlay host', async () => {
    const otherWallet = new WalletClient('json-api', 'localhost')
    const otherClient = new MessageBoxClient({
      host: OTHER_HOST,
      walletClient: otherWallet,
      overlayEnabled: true
    })

    await otherWallet.getPublicKey({ identityKey: true })
await otherClient.initializeConnection()
const otherKey = otherClient.getIdentityKey()



    await expect(otherClient.anointHost(OTHER_HOST)).resolves.not.toThrow()

    const response = await client.sendMessage({
      recipient: otherKey,
      messageBox: 'remoteForwardBox',
      body: 'Forwarded overlay message'
    })

    expect(response.status).toBe('success')
  })

  test('rejects invalid host in /overlay/anoint', async () => {
    await expect(client.anointHost('not-a-url')).rejects.toThrow('Request failed with status: 400')
  })
})
