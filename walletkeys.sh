#!/usr/bin/env bash
# walletkeys.sh — print the keys of a bigtangle wallet file.
#
# Handles the wallet-formats the current app writes, plus the validator
# keystore, and delegates legacy protobuf `.wallet` files to oldwallet.sh:
#
#   plain JSON        {"keys":[{address,pubkey,privateKey,keyType?,network?}]}
#   encrypted JSON    {salt,iv,data,N,r,p}  (app "save with password")
#   validator keystore {version,keyType:"PQ-SEED",pubkey,address,kdf,cipher,data}
#   legacy .wallet    protobuf (handled by ./oldwallet.sh)
#
# Usage:
#   ./walletkeys.sh <wallet-file> [password] [--json] [--public]
#
#   password       optional; also read from WALLET_PASSWORD or --password=<pw>,
#                  or prompted (hidden) when the file is encrypted and none is
#                  given. Prefer the prompt/env over argv so the shell history
#                  does not keep the secret.
#   --json         print machine-readable JSON
#   --public       never print private keys (addresses/public keys only)
#   -h|--help      show this help
#
# Exit codes: 0 ok, 2 usage, 3 unsupported/not a wallet file, 4 password
#             required, 5 wrong password / failed decryption.
#
# Requires the workspace SDK build: packages/bigtangle-ts/dist/index.js
#   npm --prefix packages/bigtangle-ts run build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$ROOT/packages/bigtangle-ts/dist/index.js"

JSON_OUT=0
PUBLIC_ONLY=0
PASSWORD=""
POSITIONAL=()

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -n 's/^# \{0,1\}//p'
      exit 0
      ;;
    --json) JSON_OUT=1 ;;
    --public) PUBLIC_ONLY=1 ;;
    --password=*) PASSWORD="${arg#--password=}" ;;
    --password) echo "error: --password needs a value (--password=<pw>)" >&2; exit 2 ;;
    -*) echo "error: unknown option: $arg" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

FILE="${POSITIONAL[0]:-}"
if [ -z "$FILE" ]; then
  echo "error: no wallet file given" >&2
  echo "usage: $0 <wallet-file> [password] [--json] [--public]" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "error: no such file: $FILE" >&2
  exit 2
fi

if [ "${#POSITIONAL[@]}" -ge 2 ]; then
  PASSWORD="${POSITIONAL[1]}"
elif [ -z "$PASSWORD" ]; then
  PASSWORD="${WALLET_PASSWORD:-}"
fi

if [ ! -f "$SDK" ]; then
  echo "error: SDK build not found: $SDK" >&2
  echo "       run: npm --prefix packages/bigtangle-ts run build" >&2
  exit 2
fi
if [ -n "$(find "$ROOT/packages/bigtangle-ts/src" -newer "$SDK" -name '*.ts' -print -quit 2>/dev/null)" ]; then
  echo "note: bigtangle-ts sources are newer than dist — rebuild to be sure:" >&2
  echo "      npm --prefix packages/bigtangle-ts run build" >&2
fi

# Legacy protobuf .wallet: let oldwallet.sh handle it unchanged.
if ! LC_ALL=C head -c 128 "$FILE" | grep -q '{'; then
  legacy_args=("$FILE")
  [ -n "$PASSWORD" ] && legacy_args+=("$PASSWORD")
  [ "$JSON_OUT" = 1 ] && legacy_args+=(--json)
  [ "$PUBLIC_ONLY" = 1 ] && legacy_args+=(--public)
  exec "$ROOT/oldwallet.sh" "${legacy_args[@]}"
fi

read_wallet() {
  SDK_PATH="$SDK" WALLET_FILE="$FILE" WALLET_PASSWORD="${PASSWORD:-}" \
    JSON_OUT="$JSON_OUT" PUBLIC_ONLY="$PUBLIC_ONLY" \
    node --input-type=module - <<'NODE'
import fs from 'node:fs';

const { KeyCrypterScrypt, Utils, PQKey } = await import(process.env.SDK_PATH);

const file = process.env.WALLET_FILE;
const password = process.env.WALLET_PASSWORD ?? '';
const jsonOut = process.env.JSON_OUT === '1';
const publicOnly = process.env.PUBLIC_ONLY === '1';

const fail = (code, message) => {
  if (jsonOut) console.error(JSON.stringify({ file, error: message, exitCode: code }));
  else console.error(`error: ${message}`);
  process.exit(code);
};

const text = fs.readFileSync(file, 'utf8');
let root;
try {
  root = JSON.parse(text);
} catch (e) {
  fail(3, `cannot parse ${file} as JSON: ${e.message}`);
}

const hex = (v) => {
  if (typeof v !== 'string' || v.length === 0) throw new Error('missing hex field');
  return Utils.HEX.decode(v);
};

let keys = [];
let format = '';
let encrypted = false;
let crypter = null;
let derivation = null;

if (Array.isArray(root.keys) && root.salt === undefined && root.data === undefined) {
  format = 'plain-json';
  keys = root.keys;
} else if (root.salt !== undefined && root.data !== undefined) {
  // App wallet-file format (WalletHelper.saveKeyToFile): scrypt + AES-CBC over
  // the plain SerializedWallet JSON. The app derives the key from UTF-8 bytes.
  format = 'encrypted-json';
  encrypted = true;
  if (!password) {
    if (jsonOut) console.error(JSON.stringify({ file, format, encrypted, passwordRequired: true }));
    else {
      console.error(`wallet      ${file}`);
      console.error(`format      ${format}`);
      console.error('error: the wallet is encrypted — pass its password (or set WALLET_PASSWORD)');
    }
    process.exit(4);
  }
  crypter = new KeyCrypterScrypt({
    salt: hex(root.salt),
    N: Number(root.N),
    r: Number(root.r),
    p: Number(root.p),
  });
  let plain;
  try {
    const aesKey = await crypter.deriveKey(password);
    plain = await crypter.decrypt({
      initialisationVector: hex(root.iv),
      encryptedBytes: hex(root.data),
    }, aesKey);
  } catch (e) {
    fail(5, `cannot decrypt with that password (${e?.message ?? 'bad decrypt'})`);
  }
  let inner;
  try {
    inner = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    fail(5, 'decryption succeeded but the payload is not wallet JSON (wrong password?)');
  }
  if (!Array.isArray(inner.keys) || inner.keys.length === 0) {
    fail(5, 'the decrypted payload has no keys (wrong password?)');
  }
  keys = inner.keys;
  derivation = 'utf8';
} else if (root.version !== undefined && root.keyType === 'PQ-SEED' && root.kdf && root.cipher) {
  // ValidatorKeyStore envelope (pass.md): scrypt + AES-256-CBC over the raw
  // seed. Java derives the scrypt key from UTF-16BE password bytes, so this
  // path must use deriveKeyJava (not deriveKey).
  format = 'validator-keystore';
  encrypted = true;
  const kdf = root.kdf;
  const cipher = root.cipher;
  if (kdf.name !== 'scrypt' || cipher.name !== 'aes-256-cbc') {
    fail(3, `unsupported kdf/cipher in validator keystore (${kdf.name}/${cipher.name})`);
  }
  if (!password) {
    if (jsonOut) {
      console.error(JSON.stringify({
        file, format, encrypted, address: root.address, pubkey: root.pubkey, passwordRequired: true,
      }));
    } else {
      console.error(`wallet      ${file}`);
      console.error(`format      ${format}`);
      console.error(`address     ${root.address}`);
      console.error('error: the keystore is encrypted — pass its password (or set WALLET_PASSWORD)');
    }
    process.exit(4);
  }
  crypter = new KeyCrypterScrypt({
    salt: hex(kdf.salt),
    N: Number(kdf.n),
    r: Number(kdf.r),
    p: Number(kdf.p),
  });
  let seed;
  try {
    const aesKey = await crypter.deriveKeyJava(password);
    seed = await crypter.decrypt({
      initialisationVector: hex(cipher.iv),
      encryptedBytes: hex(root.data),
    }, aesKey);
  } catch (e) {
    fail(5, `cannot decrypt keystore with that password (${e?.message ?? 'bad decrypt'})`);
  }
  // AES-CBC has no integrity tag: re-derive the pubkey and compare, exactly
  // like ValidatorKeyStore.read, so a wrong password can never print garbage.
  let pubkey = root.pubkey;
  try {
    const pqKey = PQKey.fromPrivateKeyHex(Utils.HEX.encode(seed));
    const derived = pqKey.getPublicKeyAsHex();
    if (pubkey && derived.toLowerCase() !== String(pubkey).toLowerCase()) {
      fail(5, 'cannot decrypt keystore (wrong password?): pubkey mismatch');
    }
    pubkey = derived;
  } catch (e) {
    fail(5, `cannot derive the pubkey from the decrypted seed (${e?.message ?? 'bad seed'})`);
  }
  keys = [{
    address: root.address,
    pubkey,
    privateKey: Utils.HEX.encode(seed),
    keyType: 'PQ',
  }];
  derivation = 'java-utf16be';
} else {
  fail(3, `${file} is not a recognised wallet/keystore JSON (want keys[], salt/data, or PQ-SEED envelope)`);
}

if (keys.length === 0) fail(3, 'wallet has no keys');

const rows = keys.map((k) => {
  const type = k.keyType ?? 'PQ';
  const row = {
    type,
    address: k.address ?? null,
    pubkey: k.pubkey ?? null,
    privateKey: k.privateKey ?? null,
  };
  if (k.network) row.network = k.network;
  if (publicOnly) delete row.privateKey;
  return row;
});

const encInfo = encrypted && crypter
  ? (() => {
      const p = crypter.scryptParameters ?? crypter.getScryptParameters?.();
      return p ? { type: 'scrypt-AES', N: p.N, r: p.r, p: p.p } : { type: 'scrypt-AES' };
    })()
  : null;

if (jsonOut) {
  console.log(JSON.stringify({
    file,
    format,
    encrypted,
    encryption: encInfo,
    derivation,
    keyCount: rows.length,
    keys: rows,
  }, null, 2));
} else {
  console.log(`wallet      ${file}`);
  console.log(`format      ${format}`);
  console.log(`encryption  ${encrypted ? (encInfo ? `scrypt-AES N=${encInfo.N} r=${encInfo.r} p=${encInfo.p}` : 'scrypt-AES') : 'none (unencrypted)'}`);
  if (derivation) console.log(`derivation  ${derivation}`);
  console.log(`keys        ${rows.length}`);
  rows.forEach((row, i) => {
    console.log('');
    console.log(`[${i + 1}] ${row.type}${row.network ? ` (${row.network})` : ''}`);
    console.log(`    address    ${row.address ?? '(unknown)'}`);
    console.log(`    pubkey     ${row.pubkey ?? '(unknown)'}`);
    if (!publicOnly) console.log(`    privateKey ${row.privateKey ?? '(unknown)'}`);
  });
}
NODE
}

set +e
read_wallet
rc=$?
set -e

# Encrypted file, no password given: prompt once on an interactive terminal.
if [ "$rc" -eq 4 ] && [ -z "${PASSWORD:-}" ] && [ -t 0 ]; then
  read -r -s -p "Wallet password: " PASSWORD
  echo
  set +e
  read_wallet
  rc=$?
  set -e
fi

exit "$rc"
