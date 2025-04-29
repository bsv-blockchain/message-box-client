import { Base64String, WalletClient } from '@bsv/sdk'

/**
 * Configuration options for initializing a MessageBoxClient.
 */
export interface MessageBoxClientOptions {
  /**
   * Wallet instance used for auth, identity, and encryption.
   * If not provided, a new WalletClient will be created.
   */
  walletClient?: WalletClient

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
  body: string
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
 * Defines the structure of a request to acknowledge messages.
 *
 * @example
 * {
 *   messageIds: ["abc123", "def456"]
 * }
 */
export interface AcknowledgeMessageParams {
  messageIds: string[]
  host?: string
}

/**
 * Defines the structure of a request to list messages.
 *
 * @example
 * {
 *   messageBox: "payment_inbox"
 * }
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
