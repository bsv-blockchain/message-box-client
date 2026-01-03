/**
 * RemittanceAdapter - Adapts MessageBoxClient to the CommsLayer interface
 *
 * This adapter bridges MessageBoxClient with the ts-sdk RemittanceManager by implementing
 * the CommsLayer interface. It handles the protocol differences between the two systems,
 * particularly around message body format (MessageBoxClient returns parsed objects,
 * RemittanceManager expects JSON strings).
 *
 * @example
 * ```typescript
 * import { RemittanceAdapter } from '@bsv/message-box-client'
 * import { RemittanceManager } from '@bsv/sdk'
 * import { MessageBoxClient } from '@bsv/message-box-client'
 * import { WalletClient } from '@bsv/sdk'
 *
 * const wallet = new WalletClient()
 * const messageBox = new MessageBoxClient({ walletClient: wallet })
 * const commsLayer = new RemittanceAdapter(messageBox)
 *
 * const manager = new RemittanceManager(
 *   {
 *     messageBox: 'remittance_inbox',
 *     remittanceModules: [new Brc29RemittanceModule()]
 *   },
 *   wallet,
 *   commsLayer
 * )
 * ```
 */

import { PubKeyHex } from '@bsv/sdk'
import type { MessageBoxClient } from './MessageBoxClient.js'

/**
 * Peer message format expected by RemittanceManager (matches ts-sdk PeerMessage)
 * This differs from message-box-client's PeerMessage which includes created_at/updated_at
 * TODO: Import from ts-sdk once PR is merged.
 */
export interface RemittancePeerMessage {
  messageId: string
  sender: PubKeyHex
  recipient: PubKeyHex
  messageBox: string
  body: string
}

/**
 * Communications layer interface for RemittanceManager
 * TODO: Import from ts-sdk once PR is merged.
 *
 * This intentionally mirrors the essential subset of message-box-client / MessageBoxClient.
 * RemittanceManager never talks directly to HTTP/WebSockets – it only uses this interface.
 */
export interface CommsLayer {
  /**
   * Sends a message over the store-and-forward channel. Returns the transport messageId.
   */
  sendMessage: (args: { recipient: PubKeyHex, messageBox: string, body: string }, hostOverride?: string) => Promise<string>

  /**
   * Sends a message over the live channel (e.g. WebSocket). Returns the transport messageId.
   * Implementers may throw if live sending is not possible.
   * RemittanceManager will fall back to sendMessage where appropriate.
   */
  sendLiveMessage?: (args: { recipient: PubKeyHex, messageBox: string, body: string }, hostOverride?: string) => Promise<string>

  /**
   * Lists pending messages for a message box.
   */
  listMessages: (args: { messageBox: string, host?: string }) => Promise<RemittancePeerMessage[]>

  /**
   * Acknowledges messages (deletes them from the server / inbox).
   */
  acknowledgeMessage: (args: { messageIds: string[] }) => Promise<void>

  /**
   * Optional live listener.
   */
  listenForLiveMessages?: (args: {
    messageBox: string
    overrideHost?: string
    onMessage: (msg: RemittancePeerMessage) => void
  }) => Promise<void>
}

/**
 * Adapter that implements the CommsLayer interface for MessageBoxClient
 *
 * This class wraps MessageBoxClient to provide compatibility with the RemittanceManager
 * communications interface. It handles format conversions, particularly ensuring message
 * bodies are properly stringified for the RemittanceManager protocol.
 */
export class RemittanceAdapter implements CommsLayer {
  /**
   * Creates a new RemittanceAdapter
   * @param messageBox - The MessageBoxClient instance to adapt
   */
  constructor(private readonly messageBox: MessageBoxClient) { }

  /**
   * Sends a message over the store-and-forward channel
   * @param args - Message parameters (recipient, messageBox, body)
   * @param hostOverride - Optional host override
   * @returns The transport message ID
   */
  async sendMessage(
    args: { recipient: PubKeyHex, messageBox: string, body: string },
    hostOverride?: string
  ): Promise<string> {
    const result = await this.messageBox.sendMessage({
      recipient: args.recipient,
      messageBox: args.messageBox,
      body: args.body
    })

    return result.messageId
  }

  /**
   * Sends a message over the live channel (falls back to regular sendMessage)
   * @param args - Message parameters (recipient, messageBox, body)
   * @param hostOverride - Optional host override
   * @returns The transport message ID
   */
  async sendLiveMessage(
    args: { recipient: PubKeyHex, messageBox: string, body: string },
    hostOverride?: string
  ): Promise<string> {
    // MessageBoxClient doesn't distinguish between live and regular messages
    // Both go through the same sendMessage mechanism
    return await this.sendMessage(args, hostOverride)
  }

  /**
   * Lists pending messages for a message box
   *
   * Note: MessageBoxClient returns message bodies as parsed objects, but RemittanceManager
   * expects them as JSON strings. This method handles the conversion.
   *
   * @param args - List parameters (messageBox, optional host)
   * @returns Array of peer messages with stringified bodies
   */
  async listMessages(args: { messageBox: string, host?: string }): Promise<RemittancePeerMessage[]> {
    const messages = await this.messageBox.listMessages({ messageBox: args.messageBox })

    return messages.map((msg: any) => {
      // MessageBoxClient returns body as parsed object, but RemittanceManager expects JSON string
      const bodyString = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)

      return {
        messageId: msg.messageId,
        sender: msg.sender,
        recipient: msg.recipient,
        messageBox: msg.messageBox,
        body: bodyString
      }
    })
  }

  /**
   * Acknowledges messages (deletes them from the server inbox)
   * @param args - Array of message IDs to acknowledge
   */
  async acknowledgeMessage(args: { messageIds: string[] }): Promise<void> {
    // MessageBoxClient's acknowledgeMessage expects the same format
    await this.messageBox.acknowledgeMessage({ messageIds: args.messageIds })
  }

  /**
   * Live message listening is not currently supported by MessageBoxClient
   * @throws Error indicating live message listening is not supported
   */
  async listenForLiveMessages(args: {
    messageBox: string
    overrideHost?: string
    onMessage: (msg: RemittancePeerMessage) => void
  }): Promise<void> {
    throw new Error('Live message listening is not currently supported by MessageBoxClient')
  }
}
