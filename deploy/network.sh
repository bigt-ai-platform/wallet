# deploy/network.sh — mainnet enforcement for the bapp web release train.
#
# The production export defaults to mainnet only by convention: `expo export`
# bakes __DEV__=false, and expo-app/sources/constants/app.ts +
# expo-app/sources/services/http.ts point that branch at the mainnet L1 order
# nodes (https://ordereu1.bigtangle.org, same-origin /l1/ on web), the
# same-origin /l0/ web proxy and MainNetParams seeds. Nothing else selects the
# network, so a testnet URL/TestParams sneaking into those two files would be
# silently shipped to production.
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

  # The mainnet L1 constant must pin the public order node (native) and the
  # same-origin /l1/ proxy (web). The legacy JSF host https://m.bigtangle.org
  # serves HTML, not the JSON-RPC order API, and must not come back.
  local l1_main_line
  l1_main_line="$(grep -m1 'export const DEFAULT_L1_MAINNET_URL' "$app_ts" || true)"
  if ! echo "$l1_main_line" | grep -q 'ordereu1\.bigtangle\.org' \
     || ! echo "$l1_main_line" | grep -q "'/l1/'"; then
    echo -e "${red}network guard: DEFAULT_L1_MAINNET_URL must be IS_WEB ? '/l1/' : 'https://ordereu1.bigtangle.org' ($app_ts)${nc}"
    bad=1
  fi
  if echo "$l1_main_line" | grep -q 'm\.bigtangle\.org'; then
    echo -e "${red}network guard: DEFAULT_L1_MAINNET_URL points at the legacy JSF host m.bigtangle.org ($app_ts)${nc}"
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
  # …and discoverL0Url() must resolve the L0 seeds from MainNetParams.
  if ! awk '/function discoverL0Url/{f=1} f{print} f&&/^}/{exit}' "$http_ts" | grep -q 'MainNetParams'; then
    echo -e "${red}network guard: discoverL0Url() no longer resolves mainnet L0 from MainNetParams ($http_ts)${nc}"
    bad=1
  fi
  # …while the web branch must use the same-origin /l0/ path that
  # deploy/region.sh's Caddy vhost reverse-proxies to the public L0 API (the
  # raw http:// seeds are blocked as mixed content / CORS in a browser).
  if ! awk '/function discoverL0Url/{f=1} f{print} f&&/^}/{exit}' "$http_ts" | grep -q "'/l0/'"; then
    echo -e "${red}network guard: discoverL0Url() no longer uses the same-origin /l0/ web path ($http_ts)${nc}"
    bad=1
  fi

  [ "$bad" = 0 ] && return 0
  echo -e "${red}network guard: refusing to build/deploy a non-mainnet default. Restore the mainnet constants in expo-app/sources/constants/app.ts and expo-app/sources/services/http.ts (see deploy/README.md 'Network (mainnet vs testnet)').${nc}"
  return 1
}
