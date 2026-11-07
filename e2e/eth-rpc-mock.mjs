/**
 * Minimal Ethereum JSON-RPC mock for the wallet's Ethereum spec.
 *
 * Serves deterministic balances/fees/receipts on a loopback port so the
 * deposit/withdraw UI can be exercised end to end without a chain, a provider
 * or funds. The signed raw transaction is captured (`sent()`) so the spec can
 * assert a well-formed EIP-1559 payload was broadcast.
 *
 *   node e2e/eth-rpc-mock-cli.mjs 18546   # standalone
 */

import http from 'node:http';

const USDT_BALANCE = 2_500_000n; // 2.5 USDT (6 decimals)
const NATIVE_BALANCE = 10n ** 18n; // 1 ETH

function word(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function abiString(text) {
  const hex = Buffer.from(text, 'utf8').toString('hex');
  return word(32n) + word(BigInt(hex.length / 2)).slice(2) + hex.padEnd(64, '0');
}

export function startEthRpcMock(port = 0) {
  /** @type {Array<{raw: string}>} */
  const sent = [];
  const receipts = new Map();

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.url === '/sent') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sent));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let reply;
      try {
        const rpc = JSON.parse(body || '{}');
        const { method, params = [] } = rpc;
        let result;
        switch (method) {
          case 'eth_chainId':
            result = '0x1';
            break;
          case 'eth_getBalance':
            result = `0x${NATIVE_BALANCE.toString(16)}`;
            break;
          case 'eth_call': {
            const data = params[0]?.data || '0x';
            if (data.startsWith('0x70a08231')) result = word(USDT_BALANCE);
            else if (data.startsWith('0x313ce567')) result = word(6n);
            else if (data.startsWith('0x95d89b41')) result = abiString('USDT');
            else result = word(0n);
            break;
          }
          case 'eth_feeHistory':
            result = {
              oldestBlock: '0x1',
              baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
              gasUsedRatio: [0.5],
              reward: [['0x3b9aca0']],
            };
            break;
          case 'eth_estimateGas':
            result = params[0]?.data && params[0].data !== '0x' ? '0xfde8' : '0x5208';
            break;
          case 'eth_gasPrice':
            result = '0x6fc23ac00';
            break;
          case 'eth_getTransactionCount':
            result = '0x0';
            break;
          case 'eth_sendRawTransaction': {
            const raw = params[0];
            if (typeof raw !== 'string' || !raw.startsWith('0x02') || raw.length < 200) {
              reply = { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'bad raw tx' } };
              break;
            }
            const hash = `0x${'ab'.repeat(32)}`;
            sent.push({ raw });
            receipts.set(hash, true);
            result = hash;
            break;
          }
          case 'eth_getTransactionReceipt': {
            const hash = params[0];
            result = receipts.has(hash)
              ? {
                  transactionHash: hash,
                  status: '0x1',
                  blockNumber: '0x10',
                  blockHash: `0x${'cd'.repeat(32)}`,
                }
              : null;
            break;
          }
          default:
            reply = {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32601, message: `method not mocked: ${method}` },
            };
        }
        reply ??= { jsonrpc: '2.0', id: rpc.id, result };
      } catch (e) {
        reply = { jsonrpc: '2.0', id: 0, error: { code: -32700, message: String(e) } };
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        sent,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
