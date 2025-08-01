/**
 * Permission and fee management types for MessageBox system
 */

/**
 * Parameters for setting message box permissions
 */
export interface SetMessageBoxPermissionParams {
  /** The messageBox type (e.g., 'notifications', 'inbox') */
  messageBox: string
  /** Optional sender - if omitted, sets box-wide default */
  sender?: string
  /** Recipient fee: -1=always allow, 0=block all, >0=satoshi amount required */
  recipientFee: number
}

/**
 * Parameters for getting message box permissions
 */
export interface GetMessageBoxPermissionParams {
  /** The recipient's identity key */
  recipient: string
  /** The messageBox type */
  messageBox: string
  /** Optional sender - if omitted, gets box-wide default */
  sender?: string
}

/**
 * Permission status response
 */
export interface PermissionStatus {
  /** Whether messages are allowed */
  allowed: boolean
  /** Current recipient fee setting */
  recipientFee: number
  /** Description of permission status */
  status: 'always_allow' | 'blocked' | 'payment_required'
  /** Required payment amount if payment_required */
  requiredPayment?: number
}

/**
 * Fee quote response
 */
export interface MessageBoxQuote {
  /** Server delivery fee */
  deliveryFee: number
  /** Recipient fee */
  recipientFee: number
  /** Total cost to send message */
  totalCost: number
  /** Whether the message is allowed */
  allowed: boolean
  /** Whether payment is required */
  requiresPayment: boolean
  /** Reason if blocked */
  blockedReason?: string
}

/**
 * Permission list item
 */
export interface PermissionListItem {
  /** Sender identity key (null for box-wide defaults) */
  sender: string | null
  /** MessageBox type */
  messageBox: string
  /** Recipient fee setting */
  recipientFee: number
  /** Permission status */
  status: 'always_allow' | 'blocked' | 'payment_required'
  /** Creation timestamp */
  createdAt: string
  /** Last update timestamp */
  updatedAt: string
}

/**
 * Parameters for listing permissions
 */
export interface ListPermissionsParams {
  /** Optional messageBox filter */
  messageBox?: string
  /** Optional host override */
  host?: string
  /** Optional pagination limit */
  limit?: number
  /** Optional pagination offset */
  offset?: number
}

/**
 * Parameters for getting fee quote
 */
export interface GetQuoteParams {
  /** Recipient identity key */
  recipient: string
  /** MessageBox type */
  messageBox: string
  /** Optional payment amount to validate */
  paymentAmount?: number
  /** Optional host override */
  host?: string
}
