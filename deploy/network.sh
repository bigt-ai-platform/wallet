# deploy/network.sh — mainnet enforcement for the bapp web release train.
#
# The production export defaults to mainnet only by convention: `expo export`
# bakes __DEV__=false, and expo-app/sources/constants/app.ts +
# expo-app/sources/services/http.ts point that branch at the production TLS
# entry points (PROD_L0_URL / PROD_L1_URL = eu1 / ordereu1.bigtangle.org) and
# the same-origin /l0/ + /l1/ web proxies. Nothing else selects the network, so
# a testnet URL/TestParams sneaking into those two files would be silently
# shipped to production.
#
# assert_mainnet_default() fails the release when the checked-in source no
# longer pins the canonical mainnet defaults. It is sourced by deploy/tag.sh
# (before the export) and deploy/deploy.sh (before tagging). ROOT must be set
# to the bapp repo root before sourcing.
assert_mainnet_default() {
  local app_ts="$ROOT/expo-app/sources/constants/app.ts"
  local http_ts="$ROOT/expo-app/sources/services/http.ts"
  local red='\033[0;31m' nc='\033[0m'
  local bad=0

  for f in "$app_ts" "$http_ts"; do
    [ -f "$f" ] || { echo -e "${red}network guard: source not found: $f${nc}"; return 1; }
  done

  # DEFAULT_L1_CHAINS_MAINNET must resolve its URL from the mainnet L1
  # constant — never the testnet one.
  if ! awk '/DEFAULT_L1_CHAINS_MAINNET/{f=1} f{print} f&&/];/{exit}' "$app_ts" | grep -q 'DEFAULT_L1_MAINNET_URL'; then
    echo -e "${red}network guard: DEFAULT_L1_CHAINS_MAINNET no longer resolves DEFAULT_L1_MAINNET_URL ($app_ts)${nc}"
    bad=1
  fi
  # The testnet L1 constant must not have leaked into the mainnet chain set.
  if awk '/DEFAULT_L1_CHAINS_MAINNET/{f=1} f{print} f&&/];/{exit}' "$app_ts" | grep -q 'DEFAULT_L1_TESTNET_URL'; then
    echo -e "${red}network guard: testnet L1 constant found in DEFAULT_L1_CHAINS_MAINNET ($app_ts)${nc}"
    bad=1
  fi

  # app.ts must pin the production TLS entry points and the same-origin web
  # bases. The legacy JSF host https://m.bigtangle.org serves HTML, not the
  # JSON-RPC order API, and must not come back anywhere in the app defaults.
  local l0_line l1_line l0_web l1_web
  l0_line="$(grep -m1 'export const PROD_L0_URL' "$app_ts" || true)"
  l1_line="$(grep -m1 'export const PROD_L1_URL' "$app_ts" || true)"
  l0_web="$(grep -m1 'export const PROD_WEB_L0_BASE' "$app_ts" || true)"
  l1_web="$(grep -m1 'export const PROD_WEB_L1_BASE' "$app_ts" || true)"
  if ! echo "$l0_line" | grep -q 'eu1\.bigtangle\.org'; then
    echo -e "${red}network guard: PROD_L0_URL no longer points at https://eu1.bigtangle.org ($app_ts)${nc}"
    bad=1
  fi
  if ! echo "$l1_line" | grep -q 'ordereu1\.bigtangle\.org'; then
    echo -e "${red}network guard: PROD_L1_URL no longer points at https://ordereu1.bigtangle.org ($app_ts)${nc}"
    bad=1
  fi
  if ! echo "$l0_web" | grep -q "'/l0/'"; then
    echo -e "${red}network guard: PROD_WEB_L0_BASE must be the same-origin '/l0/' path ($app_ts)${nc}"
    bad=1
  fi
  if ! echo "$l1_web" | grep -q "'/l1/'"; then
    echo -e "${red}network guard: PROD_WEB_L1_BASE must be the same-origin '/l1/' path ($app_ts)${nc}"
    bad=1
  fi
  if grep -q 'https://m\.bigtangle\.org' "$http_ts" "$app_ts"; then
    echo -e "${red}network guard: legacy JSF host https://m.bigtangle.org found in the app defaults ($http_ts / $app_ts)${nc}"
    bad=1
  fi

  # http.ts: defaultL1Url() must resolve the default L1 from the constants…
  if ! awk '/function defaultL1Url/{f=1} f{print} f&&/^}/{exit}' "$http_ts" | grep -q 'DEFAULT_L1_MAINNET_URL'; then
    echo -e "${red}network guard: defaultL1Url() no longer resolves the default L1 from DEFAULT_L1_MAINNET_URL ($http_ts)${nc}"
    bad=1
  fi
  # …and discoverL0Url() must use the same-origin /l0/ base on web and the
  # HTTPS PROD_L0_URL on native — never the raw http:// seeds for mainnet.
  local discover
  discover="$(awk '/function discoverL0Url/{f=1} f{print} f&&/^}/{exit}' "$http_ts")"
  if ! echo "$discover" | grep -q 'PROD_WEB_L0_BASE' || ! echo "$discover" | grep -q 'PROD_L0_URL'; then
    echo -e "${red}network guard: discoverL0Url() must use PROD_WEB_L0_BASE on web and PROD_L0_URL on native ($http_ts)${nc}"
    bad=1
  fi

  [ "$bad" = 0 ] && return 0
  echo -e "${red}network guard: refusing to build/deploy a non-mainnet default. Restore the mainnet constants in expo-app/sources/constants/app.ts and expo-app/sources/services/http.ts (see deploy/README.md 'Network (mainnet vs testnet)').${nc}"
  return 1
}
