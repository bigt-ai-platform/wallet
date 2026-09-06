# Deploy — bapp (Bigtangle wallet) web

Serves the bapp web wallet (expo static export) on a region VM — **fully
containerised**, mirroring `../aifeeds/deploy`. Unlike aifeeds there is no app
tier: the wallet talks to the **existing prod chain** straight from the browser
(mainnet L1 order-match at `https://m.bigtangle.org`, L0 discovered from the
network seeds), so this stack is a single nginx container + a host Caddy vhost.

```
Cloudflare (DNS-only A → region VM)
        │
┌───────▼────────┐   region VM (e.g. wallet.bigtangle.org)
│  Caddy :443     │
│  domain → :8081 (web container, 127.0.0.1)
└───────┬────────┘
        │   docker compose (deploy/compose.prod.yml)
        ▼
   nginx container = static expo web export (mainnet bundle)
```

> **Chain is NOT in this stack.** The app connects to the already-running
> mainnet/testnet chain (`m.bigtangle.org` / `testm.bigtangle.org`). Per-region
> or private chain containers are intentionally out of scope — deploy the chain
> itself with `../blockchain/helper/prod/*` if you need your own.

## Files

| File | Purpose |
|---|---|
| `compose.prod.yml` | Single `web` container (nginx static), published on `127.0.0.1:8081` |
| `Dockerfile.app` | Runtime image: packages the host-built `web-build/` export under nginx; **no compile in-image** |
| `nginx.conf` | SPA fallback (`index.html`) + hard caching of hashed Metro assets |
| `tag.sh` | HOST build: `expo export` → docker image → registry push **or** docker-save tar (no registry needed) |
| `deploy.sh` | Release train (analog `../dai/deploy/deploy.sh`): bump patch tag → `tag.sh` build+push `:vX.Y.Z` + `:latest` → `region.sh deploy` every region pinned to `:vX.Y.Z` |
| `region.sh` | Provision one region VM: load image → sync repo → `compose up` → Caddy; status/health/logs/env/destroy |
| `region.conf` | Region map: domain, VM IP, SSH user/key, `WEB_PORT`, `APP_IMAGE`, apex (edit before deploying) |

## Regions (analog `../dai`)

| Region | Domain | VM | SSH user |
|---|---|---|---|
| europa | `eu.wallet.bigt.ai` | `85.214.37.95` | `root` |
| asia | `asia.wallet.bigt.ai` | `43.132.208.9` | `ubuntu` |
| usa | `us.wallet.bigt.ai` | `43.162.118.46` | `ubuntu` |

Same fleet as `../dai` (same IPs/users/keys) — the wallet cohabits the VMs on
port `:8081` (dai uses `:3000`) with its own Caddy vhosts. The apex
`wallet.bigt.ai` / `www.wallet.bigt.ai` is served from `APEX_REGION`
(`europa`); other regions only serve their own `<region>.wallet.bigt.ai`.

## Build once, deploy anywhere

```bash
./deploy/tag.sh                 # expo export → bapp-web:latest → deploy/.image/bapp-web.latest.tar
# or push to a registry the VMs can pull:
APP_IMAGE=ghcr.io/your-org/bapp-web ./deploy/tag.sh
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
  region vhost is written to `/etc/caddy/Caddyfile.d/bapp-<region>.caddy` and
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
`deploy/.image/bapp-web.latest.tar`), syncs the compose file, starts the
container and (re)writes the Caddy vhost. Redeploy after `./deploy/tag.sh`
produces a new image. There are no systemd units and no data volumes — a wiped
VM is fully rebuilt by `deploy`.

## Network (mainnet vs testnet)

The **production export defaults to mainnet** (`IS_DEV=false` →
`https://m.bigtangle.org` L1, mainnet seeds for L0); users can switch to the
testnet chain in the app's Settings. If you want a build whose *default* is
testnet, export with the testnet URLs baked in (edit
`expo-app/sources/constants/app.ts` and the params used by
`sources/services/http.ts` before running `tag.sh`) — nothing is configurable
at runtime by design.

## CORS + mixed content (preconditions)

The browser app calls the chain endpoints cross-origin:
- L1 order-match: `https://m.bigtangle.org` (mainnet) / `https://testm.bigtangle.org` (testnet)
- L0 main chain: discovered from the network seeds
  (`MainNetParams.serverSeeds()` in `bigtangle-ts`), used with `http://<host>/`

The Java chain servers have CORS **disabled by default** (see
`CorsConfiguration.java` in `../blockchain`: `server.corsAllowedOrigins=`)
and only respond to browser cross-origin calls once you enable it:

```
server.corsAllowedOrigins=https://wallet.example.org
```

on each L0/L1 node the app will reach. Until that property is set, the web
wallet on a separate origin will be blocked by the browser. Two further notes:

1. The app builds the L0 URL as `http://<seed>/`. If the wallet is served over
   HTTPS, browsers block those as **mixed content** — for a fully HTTPS web
   deployment the app/params must switch the L0 discovery to an HTTPS URL
   (native apps are unaffected).
2. If you cannot enable CORS on the chain nodes, serve the chain API under the
   wallet's own origin instead (same-origin reverse proxy in the Caddy vhost)
   — that needs an app tweak so requests go to the relative path.

No API keys or secrets are involved — this is a public read/write wallet UI.
