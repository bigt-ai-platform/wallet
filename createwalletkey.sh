#!/usr/bin/env bash
# createwalletkey.sh — create a password-protected bigtangle wallet key file.
#
# Writes the app's encrypted wallet JSON ({salt,iv,data,N,r,p}, scrypt+AES-CBC)
# at <wallet-file>; readable again with ./walletkeys.sh.
#
# Usage:
#   ./createwalletkey.sh <wallet-file> [password] [options]
#
#   <wallet-file>    output path (refused if it exists unless --force)
#   [password]       encryption password; also --password=<pw>, WALLET_PASSWORD,
#                    or a hidden prompt (asked twice). Prefer the prompt/env so
#                    the secret does not stay in shell history.
#
# Options:
#   --from FILE      import the key(s) from an existing wallet/JSON instead of
#                    generating a new PQ key. Accepts plain wallet JSON,
#                    encrypted wallet JSON, or oldwallet.sh --json output.
#   --in-password=PW password of the --from file when it is encrypted
#                    (or WALLET_PASSWORD_IN; prompted if omitted)
#   --plain          write an UNENCRYPTED wallet JSON instead (no password)
#   --testnet        derive TestNet addresses (default MainNet)
#   -o, --output F   write to F instead of <wallet-file>
#   --force          overwrite an existing output file
#   -h, --help       show this help
#
# Exit codes: 0 ok, 2 usage, 3 bad source wallet, 4 new password required,
#             5 wrong source password, 6 output exists (use --force).
#
# Requires the workspace SDK build: packages/bigtangle-ts/dist/index.js
#   npm --prefix packages/bigtangle-ts run build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$ROOT/packages/bigtangle-ts/dist/index.js"

PASSWORD=""
IN_PASSWORD=""
FROM=""
OUT=""
PLAIN=0
TESTNET=0
FORCE=0
POSITIONAL=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -n 's/^# \{0,1\}//p'
      exit 0
      ;;
    --from)
      [ $# -ge 2 ] || { echo "error: --from needs a value" >&2; exit 2; }
      FROM="$2"; shift 2 ;;
    --from=*) FROM="${1#--from=}"; shift ;;
    --in-password)
      [ $# -ge 2 ] || { echo "error: --in-password needs a value" >&2; exit 2; }
      IN_PASSWORD="$2"; shift 2 ;;
    --in-password=*) IN_PASSWORD="${1#--in-password=}"; shift ;;
    --password)
      [ $# -ge 2 ] || { echo "error: --password needs a value" >&2; exit 2; }
      PASSWORD="$2"; shift 2 ;;
    --password=*) PASSWORD="${1#--password=}"; shift ;;
    --plain) PLAIN=1; shift ;;
    --testnet) TESTNET=1; shift ;;
    --force) FORCE=1; shift ;;
    -o|--output)
      [ $# -ge 2 ] || { echo "error: -o needs a value" >&2; exit 2; }
      OUT="$2"; shift 2 ;;
    --) shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*) echo "error: unknown option: $1" >&2; exit 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

WALLET_FILE="${POSITIONAL[0]:-}"
if [ -z "$WALLET_FILE" ]; then
  echo "error: no wallet file given" >&2
  echo "usage: $0 <wallet-file> [password] [--from FILE] [--plain] [--force]" >&2
  exit 2
fi
if [ "${#POSITIONAL[@]}" -ge 2 ] && [ -z "$PASSWORD" ]; then
  PASSWORD="${POSITIONAL[1]}"
fi
if [ -z "$PASSWORD" ] && [ "$PLAIN" = 0 ]; then
  PASSWORD="${WALLET_PASSWORD:-}"
fi
OUT="${OUT:-$WALLET_FILE}"

if [ -e "$OUT" ] && [ "$FORCE" = 0 ]; then
  echo "error: $OUT exists (use --force to overwrite)" >&2
  exit 6
fi
if [ -n "$FROM" ] && [ ! -f "$FROM" ]; then
  echo "error: --from file not found: $FROM" >&2
  exit 2
fi

if [ ! -f "$SDK" ]; then
  echo "error: SDK build not found: $SDK" >&2
  echo "       run: npm --prefix packages/bigtangle-ts run build" >&2
  exit 2
fi

# Ask for the new password twice when encrypted and none was supplied.
if [ "$PLAIN" = 0 ] && [ -z "$PASSWORD" ]; then
  if [ ! -t 0 ]; then
    echo "error: encrypted output needs a password — pass it or set WALLET_PASSWORD" >&2
    exit 4
  fi
  read -r -s -p "Password: " PASSWORD; echo >&2
  read -r -s -p "Confirm : " _confirm; echo >&2
  if [ "$PASSWORD" != "$_confirm" ]; then
    echo "error: passwords do not match" >&2
    exit 2
  fi
  unset _confirm
fi

if [ -n "$FROM" ] && [ -z "$IN_PASSWORD" ]; then
  IN_PASSWORD="${WALLET_PASSWORD_IN:-}"
  if [ -z "$IN_PASSWORD" ] && [ -t 0 ]; then
    # Only prompt if the source is actually encrypted.
    if grep -q '"salt"' "$FROM" 2>/dev/null && grep -q '"data"' "$FROM" 2>/dev/null; then
      read -r -s -p "Source wallet password: " IN_PASSWORD; echo >&2
    fi
  fi
fi

umask 077
SDK_PATH="$SDK" OUT_FILE="$OUT" WALLET_PASSWORD="$PASSWORD" \
  WALLET_PASSWORD_IN="$IN_PASSWORD" FROM_FILE="$FROM" \
  PLAIN_OUT="$PLAIN" TESTNET="$TESTNET" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs';

const { KeyCrypterScrypt, Utils, PQKey, Address, MainNetParams, TestParams } =
  await import(process.env.SDK_PATH);

const outFile = process.env.OUT_FILE;
const password = process.env.WALLET_PASSWORD ?? '';
const inPassword = process.env.WALLET_PASSWORD_IN ?? '';
const fromFile = process.env.FROM_FILE ?? '';
const plainOut = process.env.PLAIN_OUT === '1';
const testnet = process.env.TESTNET === '1';

const hex = (v) => {
  if (typeof v !== 'string' || v.length === 0) throw new Error('missing hex field');
  return Utils.HEX.decode(v);
};
const fail = (code, message) => {
  console.error(`error: ${message}`);
  process.exit(code);
};

let keys = [];
let credentials;

if (fromFile) {
  let src;
  try {
    src = JSON.parse(fs.readFileSync(fromFile, 'utf8'));
  } catch (e) {
    fail(3, `cannot parse ${fromFile} as JSON: ${e.message}`);
  }
  if (src.salt !== undefined && src.data !== undefined) {
    // Encrypted wallet JSON: decrypt with the source password (UTF-8 KDF, as
    // WalletHelper.saveKeyToFile wrote it).
    if (!inPassword) fail(4, `${fromFile} is encrypted — pass --in-password`);
    const c = new KeyCrypterScrypt({
      salt: hex(src.salt), N: Number(src.N), r: Number(src.r), p: Number(src.p),
    });
    let plain;
    try {
      const k = await c.deriveKey(inPassword);
      plain = await c.decrypt({
        initialisationVector: hex(src.iv), encryptedBytes: hex(src.data),
      }, k);
    } catch (e) {
      fail(5, `cannot decrypt ${fromFile} with that password (${e?.message ?? 'bad decrypt'})`);
    }
    try {
      src = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      fail(5, `${fromFile} decrypted but is not wallet JSON (wrong password?)`);
    }
  }
  if (!Array.isArray(src.keys) || src.keys.length === 0) {
    fail(3, `${fromFile} has no keys[] (legacy protobuf? convert with ./oldwallet.sh --json first)`);
  }
  credentials = src.credentials;
  keys = src.keys.map((k) => {
    if (!k.privateKey) throw new Error('source key has no privateKey');
    return {
      address: k.address,
      pubkey: k.pubkey,
      privateKey: k.privateKey,
      keyType: k.keyType ?? k.type ?? 'PQ',
      ...(k.network ? { network: k.network } : {}),
    };
  });
} else {
  // New random PQ key (ML-DSA-87), the same identity the app creates.
  const k = PQKey.createNew();
  const params = testnet ? TestParams.get() : MainNetParams.get();
  keys = [{
    address: Address.fromP2PKH(params, k.getPubKeyHash()).toBase58(),
    pubkey: k.getPublicKeyAsHex(),
    privateKey: k.getPrivateKeyHex(),
    keyType: 'PQ',
  }];
}

const wallet = { keys };
if (credentials) wallet.credentials = credentials;
const plainJson = JSON.stringify(wallet);

let out;
if (plainOut) {
  out = JSON.stringify(wallet, null, 2);
} else {
  if (!password) fail(4, 'encrypted output needs a password');
  const c = new KeyCrypterScrypt();
  const k = await c.deriveKey(password);
  const enc = await c.encrypt(new TextEncoder().encode(plainJson), k);
  const sp = c.scryptParameters;
  out = JSON.stringify({
    salt: Utils.HEX.encode(sp.salt),
    iv: Utils.HEX.encode(enc.initialisationVector),
    data: Utils.HEX.encode(enc.encryptedBytes),
    N: sp.N,
    r: sp.r,
    p: sp.p,
  }, null, 2);
}

fs.writeFileSync(outFile, out + '\n', { mode: 0o600 });
try { fs.chmodSync(outFile, 0o600); } catch { /* non-POSIX */ }

console.log(`wrote       ${outFile}`);
console.log(`format      ${plainOut ? 'plain-json' : 'encrypted-json (scrypt-AES)'}`);
console.log(`keys        ${keys.length}`);
keys.forEach((k, i) => {
  console.log(`[${i + 1}] ${k.keyType ?? 'PQ'}`);
  console.log(`    address    ${k.address ?? '(unknown)'}`);
  console.log(`    pubkey     ${k.pubkey ?? '(unknown)'}`);
});
NODE

echo "mode        $(stat -c '%a' "$OUT" 2>/dev/null || echo '?')"
echo "read it with: ./walletkeys.sh $OUT"
