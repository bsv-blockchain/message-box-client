# MessageBoxClient

A lightweight, extensible client for **store-and-forward** message delivery on the [BSV](https://bitcoinsv.com/) blockchain ecosystem. The `MessageBoxClient` allows parties to send and receive authenticated peer-to-peer (P2P) messages through a simple "message box" architecture:

1. **Store-and-forward:** Messages are posted to a server (MessageBoxServer) under a named "message box."  
2. **Ephemeral storage:** Once a recipient **acknowledges** receipt of the messages, they are **deleted** from the server.  
3. **Mutual authentication:** Uses [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md)–based signing and verification to ensure only authorized peers can read or post messages.  
4. **Simple integration:** Higher-level libraries (e.g., micropayment services, push-drop tokens, or specialized "tokenators") can be built on top of this client to facilitate more advanced workflows.

## Features

- **Secure by default:** Mutual authentication with the [AuthFetch](https://github.com/bitcoin-sv/authfetch) and [AuthSocketClient](https://github.com/bitcoin-sv/authsocket) libraries.  
- **P2P data exchange:** Support for direct encrypted messaging at higher layers, micropayments, tokens, and more.  
- **Flexible transport:** Send messages via **WebSockets** (live/real-time) or **HTTP**. 
- **Extensible:** The store-and-forward pattern can underpin email-like features, invoice/ticketing systems, interactive payments, etc.

---

## Installation

```bash
npm install @bsv/p2p
```

---

## Quick Start

Below is a minimal example of using `MessageBoxClient` to:

1. Initialize the client with your wallet (for identity keys and signing).  
2. Send a message to a peer.  
3. List messages in a box.  
4. Acknowledge them (which deletes them from the server).

```js
const { WalletClient } = require('@bsv/sdk')
const MessageBoxClient = require('@bsv/p2p')

// Example identity key of the recipient (public key in hex).
const johnSmithKey = '022600d2ef37d123fdcac7d25d7a464ada7acd3fb65a0daf85412140ee20884311'

async function main() {
  // 1) Create your WalletClient (this is how you obtain your identity key).
  const myWallet = new WalletClient({
    // ... wallet config here ...
  })

  // 2) Create a MessageBoxClient, pointing to a MessageBoxServer host.
  const msgBoxClient = new MessageBoxClient({
    host: 'https://messagebox.babbage.systems',
    walletClient: myWallet
  })

  // (Optional) Initialize a WebSocket connection
  // This is required if you want to listen for inbound, live messages:
  await msgBoxClient.initializeConnection()

  // 3) Send a message to John's "demo_inbox" box
  await msgBoxClient.sendMessage({
    recipient: johnSmithKey,
    messageBox: 'demo_inbox',
    body: 'Hello John! This is a test message.'
  })

  // (John logs in, queries messages in "demo_inbox", and acknowledges them...)
  // For demonstration, let's assume we are also "John" and check his messages:

  const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
  console.log(messages[0].body) // --> "Hello John! This is a test message."

  // Acknowledge (and remove) them from the server
  await msgBoxClient.acknowledgeMessage({
    messageIds: messages.map(msg => msg.messageId.toString())
  })
}

main().catch(console.error)
```

---

## Listening for Live Messages

If you want immediate push-style notifications (rather than polling via `listMessages`), you can join a WebSocket "room" and provide a callback. For example:

```js
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('Received live message in "demo_inbox":', msg.body)
  }
})
```

Messages sent to `demo_inbox` will now trigger the callback in real time. (You must call `initializeConnection()` or do any function that establishes a WebSocket before listening.)

---

## API

### Constructor

```ts
new MessageBoxClient({
  host?: string,
  walletClient: WalletClient
})
```

Creates a new instance of `MessageBoxClient`.

- **host**: The base URL of the MessageBoxServer instance you’re connecting to.  
- **walletClient**: A [WalletClient](https://github.com/bitcoin-sv) instance for signing and identity key management.

---

### `initializeConnection()`

```ts
await msgBoxClient.initializeConnection()
```

- Establishes a WebSocket connection to the specified `host` (if not already connected).  
- Authenticates using your identity key from the `walletClient`.

Useful if you plan to receive inbound messages via sockets.

---

### `listenForLiveMessages({ messageBox, onMessage })`

```ts
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('New message in "demo_inbox":', msg)
  }
})
```

- **messageBox**: The name of the message box to listen on (e.g. `"my_inbox"`).  
- **onMessage**: A callback invoked when a new message arrives.

Internally joins a WebSocket "room" for real-time notifications.

---

### `sendLiveMessage({ recipient, messageBox, body })`

```ts
const result = await msgBoxClient.sendLiveMessage({
  recipient: johnSmithKey,
  messageBox: 'demo_inbox',
  body: 'Hello in real-time!'
})
```

- Attempts to send a message via WebSockets.  
- If there’s no live socket or the socket fails, falls back to an HTTP request.  
- **recipient**: Hex-encoded public key of the recipient.  
- **messageBox**: The box name you’re delivering into (e.g. `"demo_inbox"`).  
- **body**: The message payload (string or object).

Returns a `SendMessageResponse` with `{ status: 'success', messageId }` on success.

---

### `sendMessage({ recipient, messageBox, body })`

```ts
const response = await msgBoxClient.sendMessage({
  recipient: johnSmithKey,
  messageBox: 'demo_inbox',
  body: 'Hello via HTTP!'
})
```

- Sends the message via HTTP only (no live socket).  
- **recipient**: The recipient's identity key.  
- **messageBox**: The message box name.  
- **body**: The message payload (string or object).

Returns `{ status: 'success', messageId }` on success.

---

### `listMessages({ messageBox })`

```ts
const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
```

- Lists messages for the given box.  
- Returns an array of [`PeerMessage`](#PeerMessage).

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

### `acknowledgeMessage({ messageIds })`

```ts
await msgBoxClient.acknowledgeMessage({
  messageIds: ['1234', '5678']
})
```

- Acknowledges (and **deletes**) the specified messages from the server.  
- **messageIds**: An array of message IDs (numbers as strings).  

Returns a status string (usually `"success"`).

---

## Advanced Usage

**Joining / Leaving Specific Rooms:**  
   - Use `joinRoom(messageBox)` if you want to explicitly control room membership (helpful when you want to handle multiple boxes in a single app).
   - Use `leaveRoom(messageBox)` to leave a specific room.

**Customizing Auth:**  
   - `MessageBoxClient` uses `AuthFetch` and `AuthSocketClient` under the hood. You can swap these or tweak behaviors if hosting your own MessageBoxServer.

---

## Contributing

1. Clone this repository.  
2. Install dependencies with `npm install`.  
3. Make your changes, write tests, and open a PR.  

We welcome bug reports, feature requests, and community contributions!

---

## License

The code in this repository is licensed under the [Open BSV License](https://www.bsvlicense.org/). Please see [LICENSE](./LICENSE) for more details.

---

**Happy messaging!** Build private, interactive, and decentralized applications using the BSV blockchain and `MessageBoxClient` for your P2P communication layer.