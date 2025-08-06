import { AtomicBEEF, Base64String, BasketStringUnder300Bytes, BEEF, BooleanDefaultTrue, DescriptionString5to50Bytes, HexString, LabelStringUnder300Bytes, LockingScript, OutputTagStringUnder300Bytes, PositiveIntegerOrZero, PubKeyHex, WalletInterface } from '@bsv/sdk'

/**
 * Configuration options for initializing a MessageBoxClient.
 */
export interface MessageBoxClientOptions {
  /**
   * Wallet instance used for auth, identity, and encryption.
   * If not provided, a new WalletClient will be created.
   */
  walletClient?: WalletInterface

  /**
   * Base URL of the MessageBox server.
   * @default 'https://messagebox.babbage.systems'
   */
  host?: string

  /**
   * If true, enables detailed logging to the console.
   * @default false
   */
  enableLogging?: boolean

  /**
   * Overlay network preset for routing resolution.
   * @default 'local'
   */
  networkPreset?: 'local' | 'mainnet' | 'testnet'
}

/**
 * Represents a decrypted message received from a MessageBox.
 * Includes metadata such as sender identity, timestamps, and optional acknowledgment status.
 *
 * Used in both HTTP and WebSocket message retrieval responses.
 */
export interface PeerMessage {
  messageId: string
  body: string | Record<string, any>
  sender: string
  created_at: string
  updated_at: string
  acknowledged?: boolean
}

/**
 * Parameters required to send a message.
 * Message content may be a string or object, and encryption is enabled by default.
 *
 * @example
 * {
 *   recipient: "03abc...",
 *   messageBox: "payment_inbox",
 *   body: { type: "ping" },
 *   skipEncryption: false
 * }
 */
export interface SendMessageParams {
  recipient: string
  messageBox: string
  body: string | object
  messageId?: string
  skipEncryption?: boolean
  /** Optional: Enable permission and fee checking (default: false for backwards compatibility) */
  checkPermissions?: boolean
}

/**
 * Server response structure for successful message delivery.
 *
 * Returned by both `sendMessage` and `sendLiveMessage`.
 */
export interface SendMessageResponse {
  status: string
  messageId: string
}

/**
 * Parameters for acknowledging messages in the system.
 *
 * @interface AcknowledgeMessageParams
 *
 * @property {string[]} messageIds - An array of message IDs to acknowledge.
 * @property {string} [host] - Optional host URL where the messages originated.
 */
export interface AcknowledgeMessageParams {
  messageIds: string[]
  host?: string
}

/**
 * Parameters for listing messages in a message box.
 *
 * @property messageBox - The identifier of the message box to retrieve messages from.
 * @property host - (Optional) The host URL to connect to for retrieving messages.
 */
export interface ListMessagesParams {
  messageBox: string
  host?: string
}

/**
 * Encapsulates an AES-256-GCM encrypted message body.
 *
 * Used when transmitting encrypted payloads to the MessageBox server.
 */
export interface EncryptedMessage {
  encryptedMessage: Base64String
}

export interface AdvertisementToken {
  host: string
  txid: HexString
  outputIndex: number
  lockingScript: LockingScript
  beef: BEEF
}

export interface Payment {
  tx: AtomicBEEF
  outputs: Array<{
    outputIndex: PositiveIntegerOrZero
    protocol: 'wallet payment' | 'basket insertion'
    paymentRemittance?: {
      derivationPrefix: Base64String
      derivationSuffix: Base64String
      senderIdentityKey: PubKeyHex
    }
    insertionRemittance?: {
      basket: BasketStringUnder300Bytes
      customInstructions?: string
      tags?: OutputTagStringUnder300Bytes[]
    }
  }>
  description: DescriptionString5to50Bytes
  labels?: LabelStringUnder300Bytes[]
  seekPermission?: BooleanDefaultTrue
}

/**
 * Device registration parameters for FCM notifications
 */
export interface DeviceRegistrationParams {
  /** FCM token from Firebase SDK */
  fcmToken: string
  /** Optional device identifier */
  deviceId?: string
  /** Optional platform type */
  platform?: 'ios' | 'android' | 'web'
}

/**
 * Device registration response
 */
export interface DeviceRegistrationResponse {
  status: string
  message: string
  deviceId: number
}

/**
 * Registered device information
 */
export interface RegisteredDevice {
  id: number
  deviceId: string | null
  platform: string | null
  fcmToken: string // Truncated for security (shows only last 10 characters)
  active: boolean
  createdAt: string
  updatedAt: string
  lastUsed: string
}

/**
 * Response from listing registered devices
 */
export interface ListDevicesResponse {
  status: string
  devices: RegisteredDevice[]
  description?: string // For error responses
}
