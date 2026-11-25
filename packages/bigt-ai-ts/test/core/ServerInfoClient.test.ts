import { describe, it, expect } from 'vitest';
import { ServerInfoClient } from '../../src/net/bigt-ai/pool/server/ServerInfoClient';
import { ServerInfo } from '../../src/net/bigt-ai/response/ServerInfo';

function info(url: string, chain: string, status: string): ServerInfo {
  const s = new ServerInfo();
  s.url = url;
  s.chain = chain;
  s.status = status;
  return s;
}

describe('ServerInfoClient', () => {
  it('chainMatches handles blank sides and case', () => {
    expect(ServerInfoClient.chainMatches(null, 'L0')).toBe(true);
    expect(ServerInfoClient.chainMatches('L0', null)).toBe(true);
    expect(ServerInfoClient.chainMatches('L0', '')).toBe(true);
    expect(ServerInfoClient.chainMatches('L0', 'l0')).toBe(true);
    expect(ServerInfoClient.chainMatches('L0', 'ordermatch')).toBe(false);
  });

  it('activeUrlsForChain prefers chain matches, falls back to unlabelled', () => {
    const infos = [
      info('https://eu1.bigt-ai.org', 'L0', 'active'),
      info('https://eu2.bigt-ai.org', 'L0', 'inactive'),
      info('https://ordereu1.bigt-ai.org', 'ordermatch', 'active'),
      info('https://legacy.bigt-ai.org', '', 'active'),
    ];
    expect(ServerInfoClient.activeUrlsForChain(infos, 'L0')).toEqual([
      'https://eu1.bigt-ai.org',
      'https://legacy.bigt-ai.org',
    ]);
    expect(ServerInfoClient.activeUrlsForChain(infos, 'ordermatch')).toEqual([
      'https://ordereu1.bigt-ai.org',
      'https://legacy.bigt-ai.org',
    ]);
  });

  it('blank registry and null list are empty, never throw', async () => {
    expect(await ServerInfoClient.list('  ')).toEqual([]);
    expect(ServerInfoClient.activeUrlsForChain(null, 'L0')).toEqual([]);
  });

  it('listAll unions registries and tolerates empties', async () => {
    expect(await ServerInfoClient.listAll([], 'L0')).toEqual([]);
    expect(await ServerInfoClient.listAll([null, '', '  '], 'L0')).toEqual([]);
  });
});
