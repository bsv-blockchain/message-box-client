# BSV Peer-to-peer Messaging & Payment Tools

**@bsv/p2p** is a toolkit for **peer-to-peer messaging and payments** on the BSV blockchain. It leverages a server-side **store-and-forward** system for message delivery (via `MessageBoxClient`) and also includes a higher-level **peer-to-peer payment** flow (via `PeerPayClient`). Both functionalities build on [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) for mutual authentication and identity key management, allowing secure and  authenticated exchanges of data and BSV.

## Table of Contents

1. [Introduction](#introduction)  
2. [Installation](#installation)  
3. [Overview](#overview)  
   - [MessageBoxClient](#messageboxclient-overview)  
   - [PeerPayClient](#peerpayclient-overview)  
4. [Quick Start Examples](#quick-start-examples)  
   - [Using MessageBoxClient](#using-messageboxclient)  
   - [Using PeerPayClient](#using-peerpayclient)  
5. [API Reference](#api-reference)  
   - [MessageBoxClient API](#messageboxclient-api)  
   - [PeerPayClient API](#peerpayclient-api)  
6. [Contributing](#contributing)  
7. [License](#license)

---

## 1. Introduction

The **@bsv/p2p** library provides two main tools for peer-to-peer interaction:

1. **MessageBoxClient** – A store-and-forward messaging system backed by a "message box" server. It supports authenticated sending, listing, and acknowledging (deleting) messages with a mutual-auth approach.  
2. **PeerPayClient** – A higher-level payment client built on top of `MessageBoxClient`, enabling real-time, peer-to-peer Bitcoin payments on the BSV blockchain.

Both clients use the [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md)-based authentication model. By integrating with a [WalletClient](https://github.com/bitcoin-sv), they can sign and verify messages, ensuring only authorized parties can send and receive.

---

## 2. Installation

```bash
npm install @bsv/p2p
```

The package exports both `MessageBoxClient` and `PeerPayClient`. You can import them individually in your JavaScript/TypeScript applications.

---

## 3. Overview

### 3.1. MessageBoxClient Overview

`MessageBoxClient` implements a **store-and-forward** architecture for P2P messages:

- **Store-and-forward:** Messages are posted to a central MessageBoxServer under a named "message box" (like an inbox).  
- **Ephemeral storage:** Once the recipient acknowledges the messages, they are removed from the server.  
- **Mutual authentication:** Ensures only authorized peers can read or post messages, using [AuthFetch](https://github.com/bitcoin-sv/authfetch) and [AuthSocketClient](https://github.com/bitcoin-sv/authsocket).  
- **Flexible transport:** Supports both **WebSockets** (for live, push-style delivery) and **HTTP** (for polling or fallback).  
- **Extensible:** Can be the foundation for more advanced workflows (e.g., token-based messaging, invoice/ticket systems, etc.).

#### Key Features

1. **Secure by default** using Auth libraries for signing/verification.  
2. **Real-time or delayed** delivery with sockets or HTTP.  
3. **Easy integration** with higher-level protocols and services.  

---

### 3.2. PeerPayClient Overview

`PeerPayClient` builds on `MessageBoxClient` to enable **peer-to-peer Bitcoin payments**:

- **Secure Payment Delivery:** Utilizes the same store-and-forward or live WebSocket approach for delivering payment instructions.  
- **Derivation & Signing:** Creates a unique output script for each payment, derived from sender + recipient keys.  
- **Live or Delayed:** Works with web sockets for immediate notifications, or HTTP for an asynchronous flow.  
- **Wallet Integration:** Accept or reject incoming payments. If accepted, the payment is “internalized” into your [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) compatible wallet automatically.

#### Key Features

1. **Deterministic derivation** of payment information using the SPV-compliant [BRC-29](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0029.md) protocol.  
2. **Secure transaction passing** using the `MessageBoxClient` infrastructure.  
3. **Live or offline** support for receiving payments.  
4. **Easy acceptance/refunds** with built-in methods.  

---

## 4. Quick Start Examples

Below are two condensed examples: one for basic messaging (MessageBoxClient) and another for peer-to-peer payments (PeerPayClient).

### 4.1. Using MessageBoxClient

```js
const { WalletClient } = require('@bsv/sdk')
const { MessageBoxClient } = require('@bsv/p2p')

// Example identity key of the recipient (public key in hex)
const johnSmithKey = '022600d2ef37d123fdcac7d25d7a464ada7acd3fb65a0daf85412140ee20884311'

async function main() {
  // 1) Create your WalletClient (this obtains your identity key)
  const myWallet = new WalletClient()

  // 2) Create a MessageBoxClient, pointing to a MessageBoxServer
  const msgBoxClient = new MessageBoxClient({
    host: 'https://messagebox.babbage.systems',
    walletClient: myWallet
  })

  // (Optional) Initialize a WebSocket connection (for real-time listening)
  await msgBoxClient.initializeConnection()

  // 3) Send a message to John's "demo_inbox"
  await msgBoxClient.sendMessage({
    recipient: johnSmithKey,
    messageBox: 'demo_inbox',
    body: 'Hello John! This is a test message.'
  })

  // 4) List messages in "demo_inbox"
  const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
  console.log(messages[0].body) // --> "Hello John! This is a test message."

  // 5) Acknowledge (and delete) them from the server
  await msgBoxClient.acknowledgeMessage({
    messageIds: messages.map(msg => msg.messageId.toString())
  })
}

main().catch(console.error)
```

**Listening for Live Messages**  
If you want push-style message notifications instead of polling:

```js
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('Received live message in "demo_inbox":', msg.body)
  }
})
```

---

### 4.2. Using PeerPayClient

```ts
import { WalletClient } from '@bsv/sdk'
import { PeerPayClient } from '@bsv/p2p'

async function paymentDemo() {
  // 1) Create your wallet instance
  const wallet = new WalletClient()

  // 2) Create a PeerPayClient
  const peerPay = new PeerPayClient({
    walletClient: wallet
  })

  // 3) (Optional) Listen for incoming payments
  await peerPay.listenForLivePayments({
    onPayment: async (payment) => {
      console.log('Received payment:', payment)
      // Accept it into the wallet
      await peerPay.acceptPayment(payment)
    }
  })

  // 4) Send a payment of 50,000 sats to the recipient
  await peerPay.sendLivePayment({
    recipient: '0277a2b...e3f4', // recipient's public key
    amount: 50000
  })
}

paymentDemo().catch(console.error)
```

**Note:** `sendLivePayment` will try WebSocket first and fall back to HTTP if unavailable.

---

## 5. API Reference

### 5.1. MessageBoxClient API

```ts
import { MessageBoxClient } from '@bsv/p2p'
```

#### Constructor

```ts
new MessageBoxClient({
  host?: string,
  walletClient: WalletClient
})
```

- **host**: (Optional) Base URL of the MessageBoxServer. Defaults to `https://messagebox.babbage.systems`.
- **walletClient**: A [WalletClient](https://github.com/bitcoin-sv) instance for identity key and signing.

---

#### `initializeConnection()`

```ts
await msgBoxClient.initializeConnection()
```

- Establishes a WebSocket connection to `host`.  
- Authenticates with your wallet’s identity key.  

---

#### `listenForLiveMessages({ messageBox, onMessage })`

```ts
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('New message in "demo_inbox":', msg)
  }
})
```

- Joins a WebSocket "room" for the specified `messageBox`.
- Executes `onMessage` callback whenever a new message arrives.

---

#### `sendLiveMessage({ recipient, messageBox, body })`

```ts
const result = await msgBoxClient.sendLiveMessage({
  recipient: johnSmithKey,
  messageBox: 'demo_inbox',
  body: 'Hello in real-time!'
})
```

- Sends a message via WebSockets (falls back to HTTP if the socket is not connected).
- **recipient**: Hex-encoded public key of the recipient.
- **messageBox**: Name of the box (e.g., `"demo_inbox"`).
- **body**: Message payload (string or object).

Returns a `SendMessageResponse` with `{ status: 'success', messageId }` on success.

---

#### `sendMessage({ recipient, messageBox, body })`

```ts
const response = await msgBoxClient.sendMessage({
  recipient: johnSmithKey,
  messageBox: 'demo_inbox',
  body: 'Hello via HTTP!'
})
```

- Sends the message via HTTP only.
- **recipient**: Recipient's identity key.
- **messageBox**: Name of the box.
- **body**: Message content (string or object).

Returns `{ status: 'success', messageId }` on success.

---

#### `listMessages({ messageBox })`

```ts
const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
```

- Lists messages in the specified `messageBox`.
- Returns an array of `PeerMessage`.

```ts
interface PeerMessage {
  messageId: number;
  body: string;
  sender: string;
  created_at: string;
  updated_at: string;
  acknowledged?: boolean;
}
```

---

#### `acknowledgeMessage({ messageIds })`

```ts
await msgBoxClient.acknowledgeMessage({
  messageIds: ['1234', '5678']
})
```

- Acknowledges (and **deletes**) the specified messages from the server.
- `messageIds`: Array of message IDs (as strings).

---

### 5.2. PeerPayClient API

```ts
import { PeerPayClient } from '@bsv/p2p'
```

#### Constructor

```ts
new PeerPayClient({
  walletClient: WalletClient,
  messageBoxHost?: string,
  enableLogging?: boolean
})
```

- **walletClient**: (Required) Your identity/signing wallet.  
- **messageBoxHost**: (Optional) Base URL of the MessageBoxServer. Defaults to `https://messagebox.babbage.systems`.  
- **enableLogging**: (Optional) Enables verbose debug output.

---

#### `sendPayment({ recipient, amount })`

```ts
await peerPay.sendPayment({
  recipient: '0277a2b...',
  amount: 10000
})
```

- Sends a payment using HTTP.  
- Internally derives a public key for the recipient and builds a transaction.

---

#### `sendLivePayment({ recipient, amount })`

```ts
await peerPay.sendLivePayment({
  recipient: '0277a2b...',
  amount: 15000
})
```

- Sends a payment using WebSockets, falling back to HTTP if needed.

---

#### `listenForLivePayments({ onPayment })`

```ts
await peerPay.listenForLivePayments({
  onPayment: (payment) => {
    console.log('New live payment:', payment)
  }
})
```

- Subscribes to live payments in the `payment_inbox`.
- Invokes `onPayment` callback with an `IncomingPayment` object:

```ts
interface IncomingPayment {
  messageId: number;
  sender: string;
  token: {
    customInstructions: {
      derivationPrefix: string;
      derivationSuffix: string;
    };
    transaction: any; // typically your BSV transaction format
    amount: number;
  };
}
```

---

#### `acceptPayment(payment)`

```ts
await peerPay.acceptPayment(payment)
```

- Accepts (and "internalizes") the payment into your wallet.  
- Acknowledges the message, removing it from the inbox.

---

#### `rejectPayment(payment)`

```ts
await peerPay.rejectPayment(payment)
```

- Rejects the payment, returning a **refund** to the sender (minus a small fee, e.g. 1000 sats).  
- If the amount is too small to refund, the payment is simply acknowledged and dropped.

---

#### `listIncomingPayments()`

```ts
const payments = await peerPay.listIncomingPayments()
```

- Lists all incoming payments in the `payment_inbox`.  
- Returns an array of `IncomingPayment` objects.

---

## 6. Contributing

1. Clone this repository.  
2. Install dependencies with `npm install`.  
3. Make your changes, write tests, and open a PR.  

We welcome bug reports, feature requests, and community contributions!

---

## 7. License

This code is licensed under the [Open BSV License](https://www.bsvlicense.org/). See [LICENSE](./LICENSE) for details.
