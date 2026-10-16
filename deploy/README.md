# Deploy — Bigtangle wallet web

Serves the wallet web app (expo static export) on a region VM — **fully
containerised**, mirroring `../dai/deploy`. Unlike dai there is no app
tier: the wallet talks to the **existing prod chain** straight from the browser
(mainnet L0/L1 through the same-origin `/l0/*` + `/l1/*` Caddy proxies to
`L0_API` / `L1_API`, defaults `https://eu1.bigtangle.org` /
`https://ordereu1.bigtangle.org`) so this stack is a single nginx container +
a host Caddy vhost.

```
Cloudflare (DNS-only A → region VM)
        │
┌───────▼────────┐   region VM (e.g. wallet.bigtangle.org)
│  Caddy :443     │
│  domain → :8084 (web container, 127.0.0.1)
└───────┬────────┘
        │   docker compose (deploy/compose.prod.yml)
        ▼
   nginx container = static expo web export (mainnet bundle)
```

> **Port 8081 is NOT free on the fleet** — every region VM runs a registry
> container (`reg-europa`, …) on `127.0.0.1:8081`, so the wallet uses `:8084`
> (free on europa/asia/usa, no clash with dai's `:3000` or the other `808x`
> tenants).

> **Chain is NOT in this stack.** The app connects to the already-running
> mainnet/testnet chain (`eu1.bigtangle.org` + `ordereu1.bigtangle.org` /
> `m.bigtangle.org` + `testm.bigtangle.org`). Per-region or private chain
> containers are intentionally out of scope — deploy the chain itself with
> `../blockchain/helper/prod/*` if you need your own.

## Files

| File | Purpose |
|---|---|
| `compose.prod.yml` | Single `web` container (nginx static), published on `127.0.0.1:8084` |
| `compose.p2p-engine.blob.yml` | P2P engine with **no database** (`SETTLEMENT_STORE=blob`), published on `127.0.0.1:8108` — the **default** engine stack: chain-derived projection in memory + store-only data in an encrypted blob store |
| `compose.p2p-engine.yml` | P2P engine with Postgres (`engine` + `db`, `SETTLEMENT_STORE=pg`) — opt-in for a busy chain / heavy reads |
| `Dockerfile.p2p-engine` | P2P engine runtime image (node 20, esbuild bundle; no compile host needed) |
| `Dockerfile.app` | Runtime image: packages the host-built `web-build/` export under nginx; **no compile in-image** |
| `nginx.conf` | SPA fallback (`index.html`) + hard caching of hashed Metro assets |
| `tag.sh` | HOST build: `expo export` → docker image → registry push **or** docker-save tar (no registry needed) |
| `deploy.sh` | Release train (analog `../dai/deploy/deploy.sh`): bump patch tag → `tag.sh` build+push `:vX.Y.Z` + `:latest` → `region.sh deploy` every region pinned to `:vX.Y.Z` |
| `region.sh` | Provision one region VM: load image → sync repo → `compose up` → Caddy; status/health/logs/env/destroy |
| `region.conf` | Region map: domain, VM IP, SSH user/key, `WEB_PORT`, `APP_IMAGE`, apex (edit before deploying) |
| `network.sh` | Mainnet guard (`assert_mainnet_default`): fails the release if the source no longer pins mainnet defaults (sourced by `tag.sh`/`deploy.sh`) |

## Regions (analog `../dai`)

| Region | Domain | VM | SSH user |
|---|---|---|---|
| europa | `eu.wallet.bigt.ai` | `85.214.37.95` | `root` |
| asia | `asia.wallet.bigt.ai` | `43.132.208.9` | `ubuntu` |
| usa | `us.wallet.bigt.ai` | `43.162.118.46` | `ubuntu` |

Same fleet as `../dai` (same IPs/users/keys) — the wallet cohabits the VMs on
port `:8084` (dai uses `:3000`) with its own Caddy vhosts. The apex
`wallet.bigt.ai` / `www.wallet.bigt.ai` is served from `APEX_REGION`
(`europa`); other regions only serve their own `<region>.wallet.bigt.ai`.

## Build once, deploy anywhere

```bash
./deploy/tag.sh                 # expo export → wallet-web:latest → deploy/.image/wallet-web.latest.tar
# or push to a registry the VMs can pull:
APP_IMAGE=ghcr.io/your-org/wallet-web ./deploy/tag.sh
```

`tag.sh` needs the node toolchain (node, yarn, workspace deps) — run it on a
dev/CI host, never on the VM. The region VMs only run docker + caddy.

Release train (versioned, all regions pinned to one image):

```bash
./deploy/deploy.sh                    # bump patch of latest vX.Y.Z → build+push → deploy all regions
./deploy/deploy.sh 1.2.3              # explicit version
./deploy/deploy.sh --commit --yes     # auto-commit dirty tree, skip prompt
DEPLOY_REGIONS="europa asia" ./deploy/deploy.sh   # restrict the fleet
./deploy/deploy.sh --deploy-only      # no tag/build — redeploy existing :latest
./deploy/deploy.sh --dry-run          # print the plan, do nothing
```

## Region setup

Edit `region.conf` (`REGION_VM` IP, `REGION_SSH_KEY`, `REGION_SSH_USER`,
`REGION_DOMAIN`) for the region you deploy. Defaults mirror `../dai` (same
fleet, `oraclevpc.key`).

### The VM must already have
- **docker** (compose plugin) and a user able to run it.
- **Caddy** as the host TLS gateway (shared with other tenants on the VM). The
  region vhost is written to `/etc/caddy/Caddyfile.d/wallet-<region>.caddy` and
  reloaded. If Caddy is missing, install it first (or serve the app directly
  with the nginx container publishing on :80/:443 instead).
- The region domain pointing (DNS-only A record) at the VM IP. Caddy
  auto-provisions Let's Encrypt certs (port 80 reachable).

## Usage

```bash
./deploy/region.sh deploy europa   # full provision (idempotent)
./deploy/region.sh caddy europa    # rewrite Caddy vhosts only (region + apex if APEX_REGION)
./deploy/region.sh status europa   # container + image + local http code
./deploy/region.sh health europa   # container http + public https
./deploy/region.sh logs europa     # recent container logs
./deploy/region.sh env europa      # resolved config (domain/vm/image)
./deploy/region.sh destroy europa  # stop container + remove Caddy vhost
```

`deploy` is idempotent: it loads the image (registry pull, or `docker load` of
`deploy/.image/wallet-web.latest.tar`), syncs the compose file, starts the
container and (re)writes the Caddy vhost. The remote working dir is resolved
per SSH user when `REMOTE_REPO` is empty: root → `/srv/wallet`,
ubuntu → `/home/<user>/wallet` (override with `REMOTE_REPO=...`). Redeploy after
`./deploy/tag.sh`
produces a new image. There are no systemd units and no data volumes — a wiped
VM is fully rebuilt by `deploy`.

## Network (mainnet vs testnet)

The **production export defaults to mainnet** (`IS_DEV=false` →
`https://ordereu1.bigtangle.org` L1 on native, same-origin `/l0/` + `/l1/`
proxies on web); users can switch to the testnet chain in the app's Settings.
If you want a build whose *default* is testnet, export with the testnet URLs
baked in (edit `expo-app/sources/constants/app.ts` and the params used by
`sources/services/http.ts` before running `tag.sh`) — nothing is configurable
at runtime by design.

**The release train is mainnet only.** `deploy/network.sh`
(`assert_mainnet_default`) is run by both `deploy.sh` and `tag.sh` before any
tag/build: it verifies the checked-in `constants/app.ts` +
`services/http.ts` still pin the mainnet L1 order node
(`https://ordereu1.bigtangle.org`, same-origin `/l1/` on web), the same-origin
`/l0/` web path and `MainNetParams` seeds, and **aborts the release** if a
testnet default has leaked in (the legacy JSF host `m.bigtangle.org` is
rejected too). There is intentionally no bypass — a non-mainnet build must be
done out-of-band, never through the release train.

## CORS + mixed content (preconditions)

The browser app calls the chain endpoints same-origin:
- L0 main chain: `/l0/*` → `L0_API` (`region.conf`, default
  `https://eu1.bigtangle.org`) and `/l1/*` → `L1_API` (`region.conf`, default
  `https://ordereu1.bigtangle.org`). The legacy `m.bigtangle.org` host serves
  the JSF webapp, not the JSON-RPC order API.
- The host Caddy vhost (written by `region.sh`) handles these prefixes; the
  web container also ships the same proxies in `deploy/nginx.conf` as a
  fallback for hosts where the Caddy vhost was not (re)written. Keep the
  upstreams in `region.conf` and `nginx.conf` in sync.

The chain nodes have CORS **disabled by default** (`server.corsAllowedOrigins=`
in `../blockchain`) and expose no HTTPS proxy for arbitrary origins, so the
same-origin path is what makes the web wallet work: an HTTPS page cannot call
the raw `MainNetParams.serverSeeds()` (`http://<ip>/`, mixed content) and a
cross-origin call would be blocked by CORS.

The relative paths are baked into the production web build
(`discoverL0Url()` / `DEFAULT_L1_MAINNET_URL` in
`expo-app/sources/services/http.ts` + `constants/app.ts` use `/l0/` + `/l1/`
for `Platform.OS === 'web'`); `deploy/network.sh` fails the release if those
web branches or the mainnet defaults disappear. Native builds talk to the
public nodes directly, where neither restriction applies. Nothing needs to
change on the chain nodes for this deployment model.

No API keys or secrets are involved — this is a public read/write wallet UI.

## P2P settlement engine

The P2P feature is a **separate service** (`services/p2p-engine`), not part of
the static web stack: it holds the engine ML-DSA key (signs `social.p2p-swap`
records, funds the anchor tx, is the third key of the 2-of-3 escrow) and the
store-only PII/secrets a client app must never see. It runs on the same VM,
behind the shared Caddy, which routes `https://<domain>/p2p/*` → `127.0.0.1:8108`
(the web bundle bakes `EXPO_PUBLIC_P2P_ENGINE_URL=/p2p`).

`deploy/region.sh p2p <region>` deploys it from the gitignored
`deploy/env/.env.p2p.<region>` (image pull or docker-save tar, then `compose up`).
Pick the stack with `P2P_COMPOSE` (default `deploy/compose.p2p-engine.blob.yml`,
the **no-database** stack).

Two stacks:

| Stack | Store | When |
|---|---|---|
| `compose.p2p-engine.blob.yml` | `SETTLEMENT_STORE=blob` — **no database**: orders/swap events rebuilt from L1-SOCIAL into memory at boot; profiles/proofs/escrow-signings/receipts in an encrypted blob store | **Default.** One encrypted blob target (a mounted volume or an S3/MinIO bucket) instead of a database. |
| `compose.p2p-engine.yml` | `SETTLEMENT_STORE=pg` — Postgres `db` service + `p2p-db` volume | Opt-in for a busy chain or heavy read traffic, where an in-memory projection is not enough. |

The store split is by rebuildability (`docs/p2p.md` §14): orders + swap events
are a projection of the chain (rebuildable); payment profiles, payment proofs,
escrow signings and receipt bytes are store-only and must never reach the chain.
In blob mode the store-only half is AES-256-GCM at rest (`SETTLEMENT_BLOB_KEY`)
in an S3/MinIO bucket (`SETTLEMENT_BLOB_URL/_BUCKET/_ACCESS_KEY/_SECRET_KEY`) or
a directory (`SETTLEMENT_BLOB_DIR`, a mounted volume).

No-DB deploy (the default):

```sh
# scripts/p2p-engine-key.mjs writes the secrets to deploy/env/.env.p2p.<region>,
# including SETTLEMENT_STORE=blob, SETTLEMENT_BLOB_KEY and SETTLEMENT_BLOB_DIR
# (the compose mounts the p2p-blobs volume at /data/blobs). For S3/MinIO instead
# of the volume, set in that file:
#   SETTLEMENT_BLOB_URL=https://minio.example:9000
#   SETTLEMENT_BLOB_BUCKET=p2p
#   SETTLEMENT_BLOB_ACCESS_KEY=…
#   SETTLEMENT_BLOB_SECRET_KEY=…
#   SETTLEMENT_BLOB_KEY=<openssl rand -hex 32>   # already generated
./deploy/region.sh p2p europa
```

Trade-off: blob mode scans L1-SOCIAL into memory at boot (the projector is
forced on) and assumes L1-SOCIAL is reachable at start — fine for a small/medium
chain; use `P2P_COMPOSE=deploy/compose.p2p-engine.yml` (Postgres) for a busy
chain or heavy reads. Either way the engine still needs *some* durable
confidential store — never the chain (it is public and append-only).
