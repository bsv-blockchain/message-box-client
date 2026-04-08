# CHANGELOG for `@bsv/message-box-client`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [2.0.0 - 2026-02-06](#200---2026-02-06)
- [Template for New Releases](#template-for-new-releases)

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

---

## [2.0.7] - 2026-04-08

### Added

- Payment request methods on PeerPayClient:
  - `requestPayment()` — send a payment request to a recipient
  - `cancelPaymentRequest()` — cancel a pending request
  - `listIncomingPaymentRequests()` — list requests with expiry, cancellation, and min/max amount filtering
  - `fulfillPaymentRequest()` — pay a request and send status response
  - `declinePaymentRequest()` — decline a request with optional note
  - `listPaymentRequestResponses()` — list responses to outgoing requests
  - `listenForLivePaymentRequests()` — WebSocket listener for incoming requests
  - `listenForLivePaymentRequestResponses()` — WebSocket listener for responses
- Permission management for payment requests:
  - `allowPaymentRequestsFrom()` — whitelist an identity
  - `blockPaymentRequestsFrom()` — block an identity
  - `listPaymentRequestPermissions()` — list whitelisted/blocked identities
- New message box constants: `PAYMENT_REQUESTS_MESSAGEBOX`, `PAYMENT_REQUEST_RESPONSES_MESSAGEBOX`
- New types: `PaymentRequestMessage`, `PaymentRequestResponse`, `IncomingPaymentRequest`, `PaymentRequestLimits`
- Unit tests for all 11 new methods
- Integration tests for full round-trip payment request flows

---

## [2.0.1] - 2026-02-16

### Changed

- Promise.all()!!

## [2.0.0] - 2026-02-06

### Changed

- Updated `@bsv/sdk` dependency to v2.0.0

---

### Template for New Releases

Replace `X.X.X` with the new version number and `YYYY-MM-DD` with the release date:

```
## [X.X.X] - YYYY-MM-DD

### Added
-

### Changed
-

### Deprecated
-

### Removed
-

### Fixed
-

### Security
-
```

Use this template as the starting point for each new version. Always update the "Unreleased" section with changes as they're implemented, and then move them under the new version header when that version is released.
