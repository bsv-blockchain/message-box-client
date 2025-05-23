/**
 * PeerPayClient
 *
 * Extends `MessageBoxClient` to enable Bitcoin payments using the MetaNet identity system.
 *
 * This client handles payment token creation, message transmission over HTTP/WebSocket,
 * payment reception (including acceptance and rejection logic), and listing of pending payments.
 *
 * It uses authenticated and encrypted message transmission to ensure secure payment flows
 * between identified peers on the BSV network.
 */

import { MessageBoxClient } from './MessageBoxClient.js'
import { PeerMessage } from './types.js'
import { WalletClient, P2PKH, PublicKey, createNonce, AtomicBEEF, AuthFetch, Base64String } from '@bsv/sdk'
import { Logger } from './Utils/logger.js'

export const STANDARD_PAYMENT_MESSAGEBOX = 'payment_inbox'
const STANDARD_PAYMENT_OUTPUT_INDEX = 0

/**
 * Configuration options for initializing PeerPayClient.
 */
export interface PeerPayClientConfig {
  messageBoxHost?: string
  walletClient: WalletClient
  enableLogging?: boolean // Added optional logging flag
}

/**
 * Represents the parameters required to initiate a payment.
 */
export interface PaymentParams {
  recipient: string
  amount: number
}

/**
 * Represents a structured payment token.
 */
export interface PaymentToken {
  customInstructions: {
    derivationPrefix: Base64String
    derivationSuffix: Base64String
  }
  transaction: AtomicBEEF
  amount: number
}

/**
 * Represents an incoming payment received via MessageBox.
 */
export interface IncomingPayment {
  messageId: string
  sender: string
  token: PaymentToken
}

/**
 * PeerPayClient enables peer-to-peer Bitcoin payments using MessageBox.
 */
export class PeerPayClient extends MessageBoxClient {
  private readonly peerPayWalletClient: WalletClient
  private _authFetchInstance?: AuthFetch

  constructor (config: PeerPayClientConfig) {
    const { messageBoxHost = 'https://messagebox.babbage.systems', walletClient, enableLogging = false } = config

    // 🔹 Pass enableLogging to MessageBoxClient
    super({ host: messageBoxHost, walletClient, enableLogging })

    this.peerPayWalletClient = walletClient
  }

  private get authFetchInstance (): AuthFetch {
    if (this._authFetchInstance === null || this._authFetchInstance === undefined) {
      this._authFetchInstance = new AuthFetch(this.peerPayWalletClient)
    }
    return this._authFetchInstance
  }

  /**
   * Generates a valid payment token for a recipient.
   *
   * This function derives a unique public key for the recipient, constructs a P2PKH locking script,
   * and creates a payment action with the specified amount.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<PaymentToken>} A valid payment token containing transaction details.
   * @throws {Error} If the recipient's public key cannot be derived.
   */
  async createPaymentToken (payment: PaymentParams): Promise<PaymentToken> {
    if (payment.amount <= 0) {
      throw new Error('Invalid payment details: recipient and valid amount are required')
    };

    // Generate derivation paths using correct nonce function
    const derivationPrefix = await createNonce(this.peerPayWalletClient)
    const derivationSuffix = await createNonce(this.peerPayWalletClient)

    Logger.log(`[PP CLIENT] Derivation Prefix: ${derivationPrefix}`)
    Logger.log(`[PP CLIENT] Derivation Suffix: ${derivationSuffix}`)

    // Get recipient's derived public key
    const { publicKey: derivedKeyResult } = await this.peerPayWalletClient.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: payment.recipient
    })

    Logger.log(`[PP CLIENT] Derived Public Key: ${derivedKeyResult}`)

    if (derivedKeyResult == null || derivedKeyResult.trim() === '') {
      throw new Error('Failed to derive recipient’s public key')
    }

    // Create locking script using recipient's public key
    const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

    Logger.log(`[PP CLIENT] Locking Script: ${lockingScript}`)

    // Create the payment action
    const paymentAction = await this.peerPayWalletClient.createAction({
      description: 'PeerPay payment',
      outputs: [{
        satoshis: payment.amount,
        lockingScript,
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          payee: payment.recipient
        }),
        outputDescription: 'Payment for PeerPay transaction'
      }],
      options: {
        randomizeOutputs: false
      }
    })

    if (paymentAction.tx === undefined) {
      throw new Error('Transaction creation failed!')
    }

    Logger.log('[PP CLIENT] Payment Action:', paymentAction)

    return {
      customInstructions: {
        derivationPrefix,
        derivationSuffix
      },
      transaction: paymentAction.tx,
      amount: payment.amount
    }
  }

  /**
   * Sends Bitcoin to a PeerPay recipient.
   *
   * This function validates the payment details and delegates the transaction
   * to `sendLivePayment` for processing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<any>} Resolves with the payment result.
   * @throws {Error} If the recipient is missing or the amount is invalid.
   */
  async sendPayment (payment: PaymentParams): Promise<any> {
    if (payment.recipient == null || payment.recipient.trim() === '' || payment.amount <= 0) {
      throw new Error('Invalid payment details: recipient and valid amount are required')
    }

    const paymentToken = await this.createPaymentToken(payment)

    // Ensure the recipient is included before sending
    await this.sendMessage({
      recipient: payment.recipient,
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,
      body: paymentToken
    })
  }

  /**
   * Sends Bitcoin to a PeerPay recipient over WebSockets.
   *
   * This function generates a payment token and transmits it over WebSockets
   * using `sendLiveMessage`. The recipient’s identity key is explicitly included
   * to ensure proper message routing.
   *
   * @param {PaymentParams} payment - The payment details.
   * @param {string} payment.recipient - The recipient's identity key.
   * @param {number} payment.amount - The amount in satoshis to send.
   * @returns {Promise<void>} Resolves when the payment has been sent.
   * @throws {Error} If payment token generation fails.
   */
  async sendLivePayment (payment: PaymentParams): Promise<void> {
    const paymentToken = await this.createPaymentToken(payment)

    // Ensure the recipient is included before sending
    await this.sendLiveMessage({
      recipient: payment.recipient,
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,
      body: paymentToken
    })
  }

  /**
   * Listens for incoming Bitcoin payments over WebSockets.
   *
   * This function listens for messages in the standard payment message box and
   * converts incoming `PeerMessage` objects into `IncomingPayment` objects
   * before invoking the `onPayment` callback.
   *
   * @param {Object} obj - The configuration object.
   * @param {Function} obj.onPayment - Callback function triggered when a payment is received.
   * @returns {Promise<void>} Resolves when the listener is successfully set up.
   */
  async listenForLivePayments ({
    onPayment
  }: { onPayment: (payment: IncomingPayment) => void }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,

      // Convert PeerMessage → IncomingPayment before calling onPayment
      onMessage: (message: PeerMessage) => {
        Logger.log('[MB CLIENT] Received Live Payment:', message)
        const incomingPayment: IncomingPayment = {
          messageId: message.messageId,
          sender: message.sender,
          token: JSON.parse(message.body)
        }
        Logger.log('[PP CLIENT] Converted PeerMessage to IncomingPayment:', incomingPayment)
        onPayment(incomingPayment)
      }
    })
  }

  /**
   * Accepts an incoming Bitcoin payment and moves it into the default wallet basket.
   *
   * This function processes a received payment by submitting it for internalization
   * using the wallet client's `internalizeAction` method. The payment details
   * are extracted from the `IncomingPayment` object.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<any>} Resolves with the payment result if successful.
   * @throws {Error} If payment processing fails.
   */
  async acceptPayment (payment: IncomingPayment): Promise<any> {
    try {
      Logger.log(`[PP CLIENT] Processing payment: ${JSON.stringify(payment, null, 2)}`)

      const paymentResult = await this.peerPayWalletClient.internalizeAction({
        tx: payment.token.transaction,
        outputs: [{
          paymentRemittance: {
            derivationPrefix: payment.token.customInstructions.derivationPrefix,
            derivationSuffix: payment.token.customInstructions.derivationSuffix,
            senderIdentityKey: payment.sender
          },
          outputIndex: STANDARD_PAYMENT_OUTPUT_INDEX,
          protocol: 'wallet payment'
        }],
        description: 'PeerPay Payment'
      })

      Logger.log(`[PP CLIENT] Payment internalized successfully: ${JSON.stringify(paymentResult, null, 2)}`)
      Logger.log(`[PP CLIENT] Acknowledging payment with messageId: ${payment.messageId}`)

      await this.acknowledgeMessage({ messageIds: [payment.messageId] })

      return { payment, paymentResult }
    } catch (error) {
      Logger.error(`[PP CLIENT] Error accepting payment: ${String(error)}`)
      return 'Unable to receive payment!'
    }
  }

  /**
   * Rejects an incoming Bitcoin payment by refunding it to the sender, minus a fee.
   *
   * If the payment amount is too small (less than 1000 satoshis after deducting the fee),
   * the payment is simply acknowledged and ignored. Otherwise, the function first accepts
   * the payment, then sends a new transaction refunding the sender.
   *
   * @param {IncomingPayment} payment - The payment object containing transaction details.
   * @returns {Promise<void>} Resolves when the payment is either acknowledged or refunded.
   */
  async rejectPayment (payment: IncomingPayment): Promise<void> {
    Logger.log(`[PP CLIENT] Rejecting payment: ${JSON.stringify(payment, null, 2)}`)

    if (payment.token.amount - 1000 < 1000) {
      Logger.log('[PP CLIENT] Payment amount too small after fee, just acknowledging.')

      try {
        Logger.log(`[PP CLIENT] Attempting to acknowledge message ${payment.messageId}...`)
        if (this.authFetch === null || this.authFetch === undefined) {
          Logger.warn('[PP CLIENT] Warning: authFetch is undefined! Ensure PeerPayClient is initialized correctly.')
        }
        Logger.log('[PP CLIENT] authFetch instance:', this.authFetch)
        const response = await this.acknowledgeMessage({ messageIds: [payment.messageId] })
        Logger.log(`[PP CLIENT] Acknowledgment response: ${response}`)
      } catch (error: any) {
        if (
          error != null &&
          typeof error === 'object' &&
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string' &&
          (error as { message: string }).message.includes('401')
        ) {
          Logger.warn(`[PP CLIENT] Authentication issue while acknowledging: ${(error as { message: string }).message}`)
        } else {
          Logger.error(`[PP CLIENT] Error acknowledging message: ${(error as { message: string }).message}`)
          throw error // Only throw if it's another type of error
        }
      }

      return
    }

    Logger.log('[PP CLIENT] Accepting payment before refunding...')
    await this.acceptPayment(payment)

    Logger.log(`[PP CLIENT] Sending refund of ${payment.token.amount - 1000} to ${payment.sender}...`)
    await this.sendPayment({
      recipient: payment.sender,
      amount: payment.token.amount - 1000 // Deduct fee
    })

    Logger.log('[PP CLIENT] Payment successfully rejected and refunded.')

    try {
      Logger.log(`[PP CLIENT] Acknowledging message ${payment.messageId} after refunding...`)
      await this.acknowledgeMessage({ messageIds: [payment.messageId] })
      Logger.log('[PP CLIENT] Acknowledgment after refund successful.')
    } catch (error: any) {
      Logger.error(`[PP CLIENT] Error acknowledging message after refund: ${(error as { message: string }).message}`)
    }
  }

  /**
   * Retrieves a list of incoming Bitcoin payments from the message box.
   *
   * This function queries the message box for new messages and transforms
   * them into `IncomingPayment` objects by extracting relevant fields.
   *
   * @returns {Promise<IncomingPayment[]>} Resolves with an array of pending payments.
   */
  async listIncomingPayments (): Promise<IncomingPayment[]> {
    const messages = await this.listMessages({ messageBox: STANDARD_PAYMENT_MESSAGEBOX })

    return messages.map((msg: any) => ({
      messageId: msg.messageId,
      sender: msg.sender,
      token: msg.body
    }))
  }
}
