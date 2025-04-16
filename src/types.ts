export interface Advertisement {
  identityKey: string
  host: string
  timestamp: string
  nonce: string
  signature: string
  protocol: 'MBSERVEAD'
  version: '1.0'
}
