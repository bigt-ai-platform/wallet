#!/usr/bin/env bash
# Read the keys of a legacy bigtangle .wallet (protobuf) file.
#
#   ./oldwallet.sh <wallet-file> [password] [--json] [--public]
#
#   password   optional; also read from WALLET_PASSWORD, or prompted (hidden)
#              when the file is encrypted and none is given
#   --json     print machine-readable JSON
#   --public   never print private keys / WIF (addresses only)
#   -h|--help  show this help
#
# Reads the file with the workspace TypeScript SDK (packages/bigtangle-ts/dist),
# the same WalletProtobufSerializer the wallet app uses, so it accepts every
# historic network id (Mainnet/Test/net.bigtangle/org.bitcoin.production/...).
# Encrypted wallets are decrypted with the Java UTF-16BE password derivation
# first and the SDK's UTF-8 derivation as fallback.
#
# Exit codes: 0 ok, 2 usage, 3 not a wallet file, 4 password required,
#             5 wrong password, 6 unsupported encryption.
#
# Rebuild the SDK after changing its sources:
#   npm --prefix packages/bigtangle-ts run build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$ROOT/packages/bigtangle-ts/dist/index.js"

JSON_OUT=0
PUBLIC_ONLY=0
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
    --password)
      echo "error: --password needs a value (--password=<pw>)" >&2
      exit 2
      ;;
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
else
  PASSWORD="${PASSWORD:-${WALLET_PASSWORD:-}}"
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

read_wallet() {
  SDK_PATH="$SDK" WALLET_FILE="$FILE" WALLET_PASSWORD="${PASSWORD:-}" \
    JSON_OUT="$JSON_OUT" PUBLIC_ONLY="$PUBLIC_ONLY" \
    node --input-type=module - <<'NODE'
import fs from 'node:fs';

const { WalletProtobufSerializer, Utils } = await import(process.env.SDK_PATH);

const file = process.env.WALLET_FILE;
const password = process.env.WALLET_PASSWORD ?? '';
const jsonOut = process.env.JSON_OUT === '1';
const publicOnly = process.env.PUBLIC_ONLY === '1';

const fail = (code, message) => {
  if (jsonOut) {
    console.error(JSON.stringify({ file, error: message, exitCode: code }));
  } else {
    console.error(`error: ${message}`);
  }
  process.exit(code);
};

const bytes = new Uint8Array(fs.readFileSync(file));
if (!WalletProtobufSerializer.isWallet(bytes)) {
  fail(3, `${file} is not a legacy bigtangle .wallet (protobuf) file`);
}

let proto;
try {
  proto = WalletProtobufSerializer.parseToProto(bytes);
} catch (e) {
  fail(3, `cannot decode wallet protobuf: ${e.message}`);
}

const serializer = new WalletProtobufSerializer();
let wallet;
try {
  wallet = serializer.readWallet(bytes);
} catch (e) {
  fail(3, `cannot read wallet: ${e.message}`);
}

const params = wallet.getParams();
const network = params.getId();
const version = typeof wallet.getVersion === 'function' ? wallet.getVersion() : proto.version;
const encrypted = wallet.isEncrypted();

/** Scrypt parameters of an encrypted wallet (null for plain files). */
function scryptInfo() {
  const crypter = wallet.getKeyCrypter();
  if (!crypter || typeof crypter.getScryptParameters !== 'function') return null;
  const sp = crypter.getScryptParameters();
  return {
    type: 'scrypt-AES',
    N: sp.N,
    r: sp.r,
    p: sp.p,
    salt: Utils.HEX.encode(sp.salt),
  };
}

const cryptoInfo = encrypted ? scryptInfo() : null;

function metadata(extra = {}) {
  return {
    file,
    network,
    version,
    encrypted,
    encryption: cryptoInfo,
    keyCount: proto.key?.length ?? 0,
    ...extra,
  };
}

let keys = [];
let derivation = null;

if (encrypted) {
  if (!password) {
    const meta = metadata({ passwordRequired: true });
    if (jsonOut) console.error(JSON.stringify(meta));
    else {
      console.error(`wallet      ${file}`);
      console.error(`network     ${network}`);
      console.error(`format      protobuf wallet v${version}`);
      console.error(
        `encryption  ${cryptoInfo ? `scrypt-AES N=${cryptoInfo.N} r=${cryptoInfo.r} p=${cryptoInfo.p} salt=${cryptoInfo.salt}` : 'encrypted'}`,
      );
      console.error(`keys        ${meta.keyCount} (encrypted)`);
      console.error('error: the wallet is encrypted — pass its password (or set WALLET_PASSWORD)');
    }
    process.exit(4);
  }

  const crypter = wallet.getKeyCrypter();
  if (!crypter) {
    fail(6, 'wallet is marked encrypted but carries no key crypter');
  }

  // Java clients derive the AES key from the password's UTF-16BE bytes; a few
  // SDK-written files used the UTF-8 derivation. Try Java first, then UTF-8.
  const attempts = [
    ['java-utf16be', () => crypter.deriveKeyJava(password)],
    ['utf8', () => crypter.deriveKey(password)],
  ];
  let lastError = null;
  for (const [name, derive] of attempts) {
    try {
      keys = await wallet.walletKeysAll(await derive());
      derivation = name;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!derivation) {
    fail(5, `cannot decrypt with that password (${lastError?.message ?? 'unknown error'})`);
  }
  if (keys.length === 0) {
    fail(5, 'the password decrypted no keys — wrong password?');
  }
} else {
  keys = await wallet.walletKeysAll(null);
}

const hex = (v) => Utils.HEX.encode(v);

const rows = keys.map((key) => {
  const type = typeof key.getKeyType === 'function' ? key.getKeyType() : 'EC';
  const row = {
    type,
    address: typeof key.toAddressString === 'function' ? key.toAddressString(params) : null,
  };
  if (type === 'EC') {
    row.compressed = typeof key.isCompressed === 'function' ? key.isCompressed() : undefined;
    row.pubkey = hex(key.getPubKey());
    row.privateKey = key.getPrivateKeyAsHex();
    try {
      row.wif = key.getPrivateKeyEncoded(params).toString();
    } catch {
      row.wif = null;
    }
  } else {
    row.pubkey = key.getPublicKeyAsHex();
    row.privateKey = key.getPrivateKeyHex();
  }
  if (publicOnly) {
    delete row.privateKey;
    delete row.wif;
  }
  return row;
});

if (jsonOut) {
  console.log(
    JSON.stringify(metadata({ derivation, keys: rows }), (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
} else {
  console.log(`wallet      ${file}`);
  console.log(`network     ${network}`);
  console.log(`format      protobuf wallet v${version}`);
  console.log(
    `encryption  ${encrypted
      ? `scrypt-AES N=${cryptoInfo?.N} r=${cryptoInfo?.r} p=${cryptoInfo?.p} salt=${cryptoInfo?.salt}`
      : 'none (unencrypted)'}`,
  );
  if (derivation) console.log(`derivation  ${derivation}`);
  console.log(`keys        ${rows.length}`);
  rows.forEach((row, i) => {
    console.log('');
    console.log(`[${i + 1}] ${row.type}${row.compressed === false ? ' (uncompressed)' : ''}`);
    console.log(`    address    ${row.address ?? '(unknown)'}`);
    console.log(`    pubkey     ${row.pubkey}`);
    if (!publicOnly) {
      console.log(`    privateKey ${row.privateKey}`);
      if (row.wif) console.log(`    wif        ${row.wif}`);
    }
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
