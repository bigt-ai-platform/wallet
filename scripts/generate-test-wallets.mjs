// generate-wallets.mjs — create a bigtangle app-format wallet JSON per test key
// (TestKeys) using the bigtangle-ts client. Writes to ../blockchain/helper/test/wallet/
//
// Usage: node generate-wallets.mjs [password]
//   password defaults to "bigtangle" (documented in README.md).
//
// Produces per role:
//   <role>-wallet.json        plain SerializedWallet (scripts/harness)
//   <role>-wallet.enc.json    encrypted (app "Load from file" format) with <password>
import { PQKey, Address, TestParams, Utils } from '../packages/bigtangle-ts/dist/index.js';
import { KeyCrypterScrypt } from '../packages/bigtangle-ts/dist/net/bigtangle/crypto/KeyCrypterScrypt.js';

const OUT = new URL('../../blockchain/helper/test/wallet/', import.meta.url);
const PASSWORD = process.argv[2] || 'bigtangle';

// role | seed byte (repeated 32x) — matches helper/test/TestKeys
const KEYS = [
  { role: 'genesis-wallet', byte: 0x01 },
  { role: 'yuan-wallet', byte: 0x03 },
  { role: 'l0-validator', byte: 0x04 },
  { role: 'l1-validator', byte: 0x05 },
];

function build(role, seedByte) {
  const seedHex = seedByte.toString(16).padStart(2, '0').repeat(32);
  const k = PQKey.fromPrivateKeyHex(seedHex);
  const address = Address.fromP2PKH(TestParams.get(), k.getPubKeyHash()).toBase58();
  const wallet = {
    address,
    pubkey: k.getPublicKeyAsHex(),
    privateKey: k.getPrivateKeyHex(),
    seed: k.getPrivateKeySeedAsHex(),
    keyType: 'PQ',
    network: 'Test',
  };
  const credentials = {
    url: 'https://wallet.bigt.ai',
    user: address + '@bigt.ai',
    password: Utils.HEX.encode(crypto.getRandomValues(new Uint8Array(32))),
  };
  return { wallet, credentials };
}

for (const { role, byte } of KEYS) {
  const data = build(role, byte);
  const fs = await import('node:fs/promises');

  // 1) Plain SerializedWallet ({keys:[...], credentials}) — accepted directly
  //    by the app's loadWallet plain branch; also for scripts / harness / tests.
  const serialized = { keys: [data.wallet], credentials: data.credentials };
  await fs.writeFile(new URL(role + '.json', OUT),
    JSON.stringify(serialized, null, 2) + '\n');

  // 2) Encrypted, app-loadable format (salt/iv/data/N/r/p) — the "Load from
  //    file" flow on /wallet/keys decrypts exactly this shape with PASSWORD.
  const keyCrypter = new KeyCrypterScrypt();
  const key = await keyCrypter.deriveKey(PASSWORD);
  const encrypted = await keyCrypter.encrypt(new TextEncoder().encode(JSON.stringify(serialized, null, 2)), key);
  const sp = keyCrypter.getScryptParameters();
  const encFile = {
    salt: Utils.HEX.encode(sp.salt),
    iv: Utils.HEX.encode(encrypted.initialisationVector),
    data: Utils.HEX.encode(encrypted.encryptedBytes),
    N: sp.N,
    r: sp.r,
    p: sp.p,
  };
  await fs.writeFile(new URL(role + '.enc.json', OUT),
    JSON.stringify(encFile, null, 2) + '\n');

  console.log(role.padEnd(16), data.wallet.address, '(enc pwd=' + PASSWORD + ')');
}
