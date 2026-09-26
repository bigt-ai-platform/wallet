/**
 * verify-seeds — check that a seeds registry serves usable chain nodes, using
 * the same code path the app uses (`lib/registry` + `lib/endpoints`).
 *
 *   npx tsx scripts/verify-seeds.mts [registries] [chain]
 *   npx tsx scripts/verify-seeds.mts https://eu.wallet.bigt.ai/seeds ordermatch
 *   SEEDS_URLS=http://92.5.34.128:8089 npx tsx scripts/verify-seeds.mts
 *
 * Exit code is non-zero if no healthy node is discovered (CI/ops gate).
 */
import { fetchRegistryNodes } from '../expo-app/sources/lib/registry.ts';
import { parseChainProbe, rankProbes, type ProbeResult } from '../expo-app/sources/lib/endpoints.ts';

const registries = (process.argv[2] ?? process.env.SEEDS_URLS ?? 'http://92.5.34.128:8089')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const chain = process.argv[3] ?? 'L0';

async function probe(url: string): Promise<ProbeResult | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/getChainNumber`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return null;
    const parsed = parseChainProbe(await res.json());
    return parsed ? { url, chainLength: parsed.chainLength, latencyMs: Date.now() - t0 } : null;
  } catch {
    return null;
  }
}

const nodes = await fetchRegistryNodes(registries, chain);
console.log(`registries: ${registries.join(', ')}  chain: ${chain}`);
console.log(`discovered: ${nodes.length} active node(s)`);

const health = (await Promise.all(nodes.map(probe))).filter((r): r is ProbeResult => r !== null);
for (const r of rankProbes(health, { now: Date.now() })) {
  console.log(`  ok   ${r.url}  chainLength=${r.chainLength}  ${r.latencyMs}ms`);
}
for (const u of nodes.filter((n) => !health.some((h) => h.url === n))) {
  console.log(`  FAIL ${u}  (unreachable / not serving) `);
}

if (health.length === 0) {
  console.error('no healthy node discovered — registry unreachable or empty');
  process.exit(1);
}
console.log(`best: ${rankProbes(health, { now: Date.now() })[0].url}`);
