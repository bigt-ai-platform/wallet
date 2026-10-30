import { test, expect, Page, Route } from '@playwright/test';
import { waitForApp, clickTab } from '../helpers';

/**
 * Chains page (`/network`) — the rows must be the live mainnet node set
 * (eu1, eu2, hk1 / ordereu1, ordereu2, orderhk1) reached through their
 * same-origin proxy paths, not the retired compiled seeds (eu3…eu5 /
 * ordereu3…ordereu5) the page used to carry. Each row is probed with
 * `getChainNumber` and shows the chain state; the live peer list a node
 * publishes (`/serverinfolist`) is folded in, so a peer that maps onto a known
 * node never duplicates a row.
 *
 * The e2e web server has no `/l0`,`/l1` reverse proxy (the deploy stack owns
 * those), so the chain calls are stubbed here.
 */
const L0_NODES = ['eu1', 'eu2', 'hk1'];
const L1_NODES = ['ordereu1', 'ordereu2', 'orderhk1'];

const PROBE = {
  txReward: { chainLength: 5000, blockHashHex: 'aa'.repeat(32), confirmed: true },
  finalizedChainLength: 4999,
  justifiedEpoch: 10,
  finalizedEpoch: 9,
  justifiedBlockHash: 'bb'.repeat(32),
  finalizedBlockHash: 'cc'.repeat(32),
};

/** Serve the chain RPC the app calls under /l0|/l1 (the deploy proxy's job). */
async function stubChain(
  page: Page,
  opts: { offline?: string[]; chainLength?: Record<string, number> } = {},
) {
  const offline = new Set(opts.offline ?? []);
  const handle = (role: 'l0' | 'l1') => async (route: Route) => {
    const url = route.request().url();
    const node = url.split(`/${role}/`)[1]?.split('/')[0] ?? '';
    if (url.includes('/serverinfolist')) {
      // What a node publishes: its live peers, as raw addresses.
      return route.fulfill({
        json: {
          serverInfoList: role === 'l0'
            ? [
              { url: 'http://43.129.198.77:8082', chain: 'L0', status: 'active' },
              { url: 'http://85.215.91.140:8082', chain: 'L0', status: 'active' },
            ]
            : [{ url: 'https://ordereu2.bigtangle.org', status: 'active' }],
        },
      });
    }
    if (offline.has(node)) return route.fulfill({ status: 503, body: 'down' });
    if (url.includes('/getPeers')) return route.fulfill({ json: { count: 2, self: 'abcdef' } });
    const chainLength = opts.chainLength?.[node] ?? PROBE.txReward.chainLength;
    return route.fulfill({
      json: {
        ...PROBE,
        txReward: {
          ...PROBE.txReward,
          chainLength,
          // Same height → same head (head agreement); a lagging stub gets its
          // own hash so it is a spread/behind case, not a fork at one height.
          blockHashHex: chainLength === PROBE.txReward.chainLength
            ? PROBE.txReward.blockHashHex
            : chainLength.toString(16).padStart(64, '0'),
        },
      },
    });
  };
  await page.route('**/l0/**', handle('l0'));
  await page.route('**/l1/**', handle('l1'));
}

async function openChains(page: Page) {
  await waitForApp(page);
  await clickTab(page, 'Chains');
  await expect(page.getByTestId('network-screen')).toBeVisible({ timeout: 15000 });
}

test('lists every live node under its own proxy path and probes it', async ({ page }) => {
  await stubChain(page);
  await openChains(page);

  // Three L0 + three L1 rows: the live peer list maps onto nodes already in
  // the compiled table, so it must not duplicate or inflate the set.
  await expect(page.getByTestId('network-row')).toHaveCount(6);

  for (const name of [...L0_NODES, ...L1_NODES]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  // Retired nodes from the old seed list must not come back.
  await expect(page.getByText('eu3', { exact: true })).toHaveCount(0);
  await expect(page.getByText('eu4', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ordereu3', { exact: true })).toHaveCount(0);

  // Every row answered its probe through /l0|/l1/<node>/getChainNumber.
  await expect(page.getByTestId('network-status-online')).toHaveCount(6);
  await expect(page.getByText('5000', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('network-detail')).toHaveCount(6);
});

test('drops retired nodes cached as learned peers', async ({ page }) => {
  // An earlier deployment carried eu3…eu5 / ordereu3…ordereu5 proxies; those
  // paths were remembered as "reachable peers" in this durable list. They are
  // not nodes any more and must not become rows — nor may the bare /l0, /l1
  // primary aliases duplicate eu1/ordereu1.
  await page.addInitScript(() => {
    const seed = (role: string, urls: string[]) =>
      localStorage.setItem(
        `discovery-learned.main.${role}`,
        JSON.stringify({ at: Date.now(), urls }),
      );
    seed('l0', ['/l0/eu2', '/l0/eu1', '/l0', '/l0/eu5', '/l0/eu3']);
    seed('l1', ['/l1p', '/l1/ordereu1', '/l1', '/l1/ordereu4', '/l1/ordereu5', '/l1/ordereu3']);
  });
  await stubChain(page);
  await openChains(page);

  // Still exactly the six live nodes — no stale/alias rows.
  await expect(page.getByTestId('network-row')).toHaveCount(6);
  for (const retired of ['eu3', 'eu5', 'ordereu3', 'ordereu4', 'ordereu5', 'l1p']) {
    await expect(page.getByText(retired, { exact: true })).toHaveCount(0);
  }
  for (const name of [...L0_NODES, ...L1_NODES]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test('collapses and re-expands a row', async ({ page }) => {
  await stubChain(page);
  await openChains(page);
  const rows = page.getByTestId('network-row');
  await expect(rows).toHaveCount(6);

  await rows.first().click();
  await expect(page.getByTestId('network-detail')).toHaveCount(5);
  await rows.first().click();
  await expect(page.getByTestId('network-detail')).toHaveCount(6);
});

test('shows only the nodes that pass the chain check', async ({ page }) => {
  // checkchains.sh SPREAD_MAX is 8: eu2 lagging 100 blocks behind the head is
  // not a usable node, so it must not be listed as a chain of its own.
  await stubChain(page, { chainLength: { eu2: 4900 } });
  await openChains(page);

  await expect(page.getByTestId('network-row')).toHaveCount(5);
  await expect(page.getByText('eu2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('eu1', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('hk1', { exact: true }).first()).toBeVisible();
  // The page still reports that a node was dropped, with a count.
  await expect(page.getByTestId('network-excluded')).toHaveCount(1);
  await expect(page.getByTestId('network-excluded').first()).toContainText('1 node(s)');
});

test('reports an outage as a failed check instead of an offline row', async ({ page }) => {
  await stubChain(page, { offline: ['hk1', 'orderhk1'] });
  await openChains(page);

  // Only the nodes that answered and passed remain listed.
  await expect(page.getByTestId('network-row')).toHaveCount(4);
  await expect(page.getByTestId('network-status-offline')).toHaveCount(0);
  await expect(page.getByTestId('network-status-online')).toHaveCount(4);
  await expect(page.getByText('hk1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('orderhk1', { exact: true })).toHaveCount(0);
  // One hidden node per role is reported.
  await expect(page.getByTestId('network-excluded')).toHaveCount(2);
  await expect(page.getByTestId('network-excluded').first()).toContainText('1 node(s)');
});
