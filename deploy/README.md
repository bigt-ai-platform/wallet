# Deploy — bapp (Bigtangle wallet) web

Serves the bapp web wallet (expo static export) on a region VM — **fully
containerised**, mirroring `../aifeeds/deploy`. Unlike aifeeds there is no app
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
container and (re)writes the Caddy vhost. The remote working dir is resolved
per SSH user when `REMOTE_REPO` is empty: root → `/srv/bapp`,
ubuntu → `/home/<user>/bapp` (override with `REMOTE_REPO=...`). Redeploy after
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

The browser app calls the chain endpoints same-origin through Caddy:
- L0 main chain: `/l0/*` → `L0_API` (`region.conf`, default
  `https://eu1.bigtangle.org`).
- L1 order-match: `/l1/*` → `L1_API` (`region.conf`, default
  `https://ordereu1.bigtangle.org`). The legacy `m.bigtangle.org` host serves
  the JSF webapp, not the JSON-RPC order API.

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
