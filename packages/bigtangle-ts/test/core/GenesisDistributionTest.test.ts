import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UtilGeneseBlock,
  GenesisOutput,
  MainNetParams,
  NetworkParameters,
  PQKey,
  Address,
  Block,
} from '../../src/index';

describe('GenesisDistribution', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    delete process.env[UtilGeneseBlock.GENESIS_CSV_PROPERTY];
  });

  it('testPerAddressDistribution', () => {
    const params = MainNetParams.get();
    const a = PQKey.createNew();
    const b = PQKey.createNew();

    const distribution: GenesisOutput[] = [];
    distribution.push(GenesisOutput.toPubkey(BigInt(1_000), Utils_hex(a.getPubKey())));
    distribution.push(GenesisOutput.toPubkey(BigInt(2_000), Utils_hex(b.getPubKey())));

    const genesis: Block = UtilGeneseBlock.createGenesis(params, distribution);
    const coinbase = genesis.getTransactions()![0];

    expect(coinbase.getOutputs().length).toBe(2);
    expect(coinbase.getOutputs()[0].getValue().getValue()).toBe(BigInt(1_000));
    expect(coinbase.getOutputs()[1].getValue().getValue()).toBe(BigInt(2_000));
  });

  it('testDistributionSumMatchesTotalSupply', () => {
    const params = MainNetParams.get();
    const a = PQKey.createNew();
    const b = PQKey.createNew();

    const total = NetworkParameters.BigtangleCoinTotal;
    const half = total / BigInt(2);
    const distribution: GenesisOutput[] = [];
    distribution.push(GenesisOutput.toPubkey(half, Utils_hex(a.getPubKey())));
    distribution.push(GenesisOutput.toPubkey(total - half, Utils_hex(b.getPubKey())));

    const genesis = UtilGeneseBlock.createGenesis(params, distribution);
    let sum = BigInt(0);
    for (const out of genesis.getTransactions()![0].getOutputs())
      sum += out.getValue().getValue();
    expect(sum).toBe(total);
  });

  it('testEmptyDistributionFallsBackToGenesisPub', () => {
    const params = MainNetParams.get();
    const withList = UtilGeneseBlock.createGenesis(params, []);
    const legacy = UtilGeneseBlock.createGenesis(params);
    expect(legacy.getHash().toString()).toBe(withList.getHash().toString());
    expect(legacy.getTransactions()![0].getOutputs().length).toBeGreaterThanOrEqual(1);
  });

  it('testLoadGenesisOutputsFromCsv', () => {
    const params = MainNetParams.get();
    const a = PQKey.createNew();
    const b = PQKey.createNew();
    const addrB = Address.fromP2PKH(params, b.getPubKeyHash()).toBase58();

    const dir = mkdtempSync(join(tmpdir(), 'genesis-'));
    tmpDirs.push(dir);
    const f = join(dir, 'genesis.csv');
    writeFileSync(f, [
      'address,pubkey,value',
      ',' + Utils_hex(a.getPubKey()) + ',111',
      addrB + ',,222',
    ].join('\n'));

    const list = UtilGeneseBlock.loadGenesisOutputsFromCsv(f);
    expect(list.length).toBe(2);
    expect(list[0].pubkeyHex).not.toBeNull();
    expect(list[0].address).toBeNull();
    expect(list[0].amount).toBe(BigInt(111));
    expect(list[1].address).not.toBeNull();
    expect(list[1].pubkeyHex).toBeNull();
    expect(list[1].amount).toBe(BigInt(222));
  });

  it('testCreateGenesisUsesCsvProperty', () => {
    const params = MainNetParams.get();
    const a = PQKey.createNew();
    const dir = mkdtempSync(join(tmpdir(), 'genesis-'));
    tmpDirs.push(dir);
    const f = join(dir, 'genesis.csv');
    writeFileSync(f, [
      'address,pubkey,value',
      ',' + Utils_hex(a.getPubKey()) + ',5000',
    ].join('\n'));

    process.env[UtilGeneseBlock.GENESIS_CSV_PROPERTY] = f;
    try {
      const genesis = UtilGeneseBlock.createGenesis(params);
      expect(genesis.getTransactions()![0].getOutputs().length).toBe(1);
      expect(genesis.getTransactions()![0].getOutputs()[0].getValue().getValue())
        .toBe(BigInt(5000));
    } finally {
      delete process.env[UtilGeneseBlock.GENESIS_CSV_PROPERTY];
    }
  });
});

function Utils_hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
