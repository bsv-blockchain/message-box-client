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
