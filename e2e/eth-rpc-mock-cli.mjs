#!/usr/bin/env node
/** Standalone runner for the Ethereum JSON-RPC mock (see eth-rpc-mock.mjs). */
import { startEthRpcMock } from './eth-rpc-mock.mjs';

const port = Number(process.argv[2] || 18546);
const mock = await startEthRpcMock(port);
console.log(`ethereum rpc mock on ${mock.url}`);
