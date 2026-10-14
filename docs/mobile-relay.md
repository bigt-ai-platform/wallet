# mobile-relay.md — reach the on-phone MCP with no inbound port (like the dsh relay)

How to drive the **on-phone** `android-remote-control-mcp` endpoint from the
wallet/dai when the phone has **no reachable inbound address** — by making the
**phone dial out** to a relay, exactly like the BYO `dsh` connector
([dai-dsh-use.md §17](../dai/dai-dsh-use.md), `packages/dsh-tunnel`,
`services/dsh-relay`, `dai connect`). It is the mobile analog of the dsh relay:
same framing, same short-code pairing, same "the client routes by a handle, the
relay brokers transport".

Today the mobile path is **direct**: `wallet /device` and dai `#mobile`
(`mobile-control` `AndroidMcpClient`) `POST {base_url}/mcp`, so the phone must be
reachable — loopback (same phone), a LAN IP, or a tunnel the user runs. This
removes that requirement.

---

## 1. Why

- A phone behind mobile/LAN NAT cannot accept inbound connections; asking the
  user to run a Cloudflare/ngrok tunnel is the current workaround and it is the
  user's to operate.
- dsh already solved the same shape: the home dials out, the relay proxies in,
  a short code pairs the two. The phone is the "home"; the wallet/dai is the
  "browser".
- It also removes adb: no USB forward, no host in the loop.

## 2. Topology

```
 phone (android-remote-control-mcp)
   │  WebSocket out  wss://<relay>/mobile-connect   (mTLS/DID-authenticated, dial-out)
   ▼
 relay  (new service; shares code with services/dsh-relay)
   ├─ GET  /mobile-connect          ← outbound WSS from the phone
   ├─ POST /mobile-relay/pair       ← the client spends the phone's code
   └─ /mobile-u/<handle>/*          → framed /mcp to the paired phone
   ▲
   │  https
 wallet /device · dai #mobile  (mobile-control relay transport)
```

No inbound port on the phone. One outbound WSS, kept alive with heartbeat +
reconnect.

## 3. Components

| Piece | Where | Role |
|---|---|---|
| **Phone connector** | `android-remote-control-mcp` (Kotlin) | dials the relay, authenticates, bridges framed `req`→ local `POST http://127.0.0.1:<port>/mcp`, streams `res/chunk/end`. Adds the local bearer token itself, so it never leaves the phone. Prints the relay's pairing code on the Server screen. |
| **Relay** | new `services/mobile-relay` (mirror `services/dsh-relay`) | WSS upgrader (`/mobile-connect`), `PairingRegistry` + `RelayHub` (reuse `@dai/dsh-tunnel`), `/mobile-relay/pair`, `/mobile-u/<handle>/*` proxy, session minting. |
| **Client transport** | `packages/mobile-control` | a `RelayMobileClient` (same `DeviceGateway` surface) that frames `AndroidMcpClient` calls through `/mobile-u/<handle>/mcp`. Wallet `/device` and dai `#mobile` gain a "relay URL + code" pairing mode. |

## 4. Frame protocol — reuse dsh's verbatim

`packages/dsh-tunnel/src/protocol.ts`'s frame set already fits: the proxied
surface is stateless JSON-RPC.

```ts
{ t:"req",  id, method, path, headers, body? }     // relay → phone
{ t:"res",  id, status, headers }                  // phone → relay
{ t:"chunk",id, data } | { t:"end", id } | { t:"error", id, message }
{ t:"hello", v, did, token }                       // phone → relay (first)
{ t:"ready", did, code?, codeExpiresAt? }          // relay → phone (issues code)
{ t:"pairing", code, expiresAt? }                  // relay → phone (renewed code)
{ t:"denied", message }                            // relay → phone (then close)
```

Generalize the package: rename `dsh-tunnel` → a shared `relay-tunnel` (or add
`MOBILE_TUNNEL_PATH = "/mobile-connect"`, `MOBILE_RELAY_PROTOCOL = 1`), keeping
the dsh exports as aliases so nothing breaks. The phone implements the **same
JSON frames** in Kotlin (a small sealed class + `org.json`), so it interoperates
with the existing relay codec.

## 5. Identity & auth

The dsh home authenticates with the user's `did:key`. The phone has no dai
identity, so it mints its own **device identity** at first run:

- On first launch the app generates an **Ed25519** keypair (Android Keystore)
  and derives a `did:key:z…` (`deviceDid`), persisted like the bearer token.
- **Phone → relay:** `hello { did: deviceDid, token }` where `token` is an
  Ed25519 `DID`-signed token (`aud = relay aud`), the same scheme as
  `@dai/did/dshauth` `signDshToken`. The relay verifies it and binds the tunnel
  to `deviceDid`.
- **Client → relay:** the wallet/dai proves the user's wallet DID (a short-lived
  DID token in the pair body, or the same-origin `dai.session`), and thereafter
  carries the short relay session minted at pairing (a small header, never the
  ~14 KB DID token). This is identical to dsh's browser path.

Channel to the phone is **authenticated**; the local bearer token is added by the
connector on the phone and never transits the relay.

## 6. Pairing (short code, like dsh)

1. Phone opens the tunnel → relay sends `ready { code }` (8-char, unambiguous,
   10-min TTL, single-use; re-issued before expiry via `pairing`).
2. The phone shows the code on its **Server** screen ("Reach me anywhere:
   `<relay-domain>` · code `ABCD1234`"). No inbound URL.
3. The client (wallet `/device` or dai `#mobile`) enters the **relay URL** and
   the **code**, proving the wallet DID.
4. Relay `POST /mobile-relay/pair` → `PairingRegistry.consume(code)` → bind
   `mobileUserHandle(walletDid) → deviceDid` → mint a short session.
5. The client then drives MCP at `https://<relay>/mobile-u/<handle>/mcp`.

Revocation: relay `POST /mobile-relay/unpair` clears the binding; the phone can
also stop the connector. Binding outlives a tunnel reconnect so a phone restart
does not force re-pairing (identical to dsh).

`mobileUserHandle(did)` — a short stable handle derived from the wallet DID (the
dai `dshUserHandle` shape), because a `did:key` is ~3.5 KB.

## 7. The proxied surface is tiny

`/mcp` is stateless Streamable HTTP — **one self-contained JSON-RPC `POST` per
tool call**, no session id and no WebSocket. So the tunnel needs only
request/response framing; no SSE. `req` carries the JSON-RPC body; the phone
forwards it to local Ktor `/mcp` (adding its bearer) and returns `res`+`chunk`+
`end`. Everything the p2p verification needs (`android_get_screen_state`,
`android_list_apps`, `android_notification_list`, `android_tap`, …) rides the
same one-POST-per-call path.

## 8. Security

- **The phone runs shell-capable device control** — the relay is a high-value
  target (same warning as dsh §17.5). Mandatory: DID-bound tunnels, per-user
  routing by handle, fail-closed when unauthenticated, no verbatim passthrough of
  browser-supplied headers (`authorization`/`cookie`/`host` are dropped; the
  connector adds the phone's own token locally).
- **Relay-blind E2E** (dsh phase B3): seal request/response bodies with a key the
  relay does not hold (derived from the wallet identity via `@dai/core/frame-cipher`),
  so the operator can drop/reroute but not read or forge a turn. Method/path/status
  stay visible.
- **Rate/abuse limits** per DID and per IP on `/mobile-relay/pair` (dsh uses
  20/min/IP).
- **Revocation**: unpair, or stop the connector; a revoked binding never routes.

## 9. Offline / lifecycle

- New client states: **no backend**, **connecting**, **online**, **offline**
  (like the dsh tab). On `offline`, the client shows "start the connector on
  your phone" instead of an error.
- One active tunnel per device DID (last-writer-wins); reconnect with capped
  backoff on the phone.
- A dropped tunnel ends an in-flight tool call (no mid-turn cancel on the MCP
  side, either); the UI must say so rather than hang.

## 10. Phases

- **M0 — protocol.** Generalize `dsh-tunnel` framing (`MOBILE_TUNNEL_PATH`),
  add the Kotlin frame codec + `deviceDid` identity. No transport yet.
- **M1 — LAN proof.** Connector + relay in one host; `wallet /device` drives MCP
  through `/mobile-u/<handle>` (integration test drives a real WebSocket tunnel).
- **M2 — WSS + pairing.** Public listener, DID-bound phone, per-user routing,
  short-code pairing, relay session; `wallet /device` and dai `#mobile` gain the
  "relay URL + code" mode. Accept: unauthenticated/wrong-DID refused; offline →
  `503`.
- **M3 — E2E.** Relay-blind payloads (`frame-cipher`); the relay test asserts it
  sees only ciphertext.
- **M4 — lifecycle.** Revocation UI, multi-device, reconnect backoff.

## 11. Testing

- **Unit:** frame codec (Kotlin ↔ TS round-trip), `mobileUserHandle`, pairing
  registry TTL/single-use.
- **Integration:** a real WebSocket tunnel with a mock phone serving `/mcp`;
  assert a tool call streams back; assert an unauthenticated `/mobile-u` is 401
  and an offline handle is 503.
- **e2e:** `wallet /device` pairs by relay code and runs `android_get_screen_state`
  through the relay against a mock endpoint.

## 12. Non-goals

- Not a general-purpose proxy: only the phone's `/mcp` surface is exposed.
- Not a replacement for the direct path — loopback/LAN/tunnel keep working when
  the phone is reachable; the relay is the fallback for NAT.
- No platform-hosted phone identity: `deviceDid` is minted on the phone and the
  key never leaves it (mirrors "no engine-owned devices", docs/p2p.md §14).
