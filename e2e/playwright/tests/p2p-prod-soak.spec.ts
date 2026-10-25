import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Bounded smoke for the long-running production soak harness
 * (`e2e/prod-soak.mjs`). It runs a short READ-ONLY pass against the deployed
 * stack and asserts the report's error/latency/stability budget. The real
 * hours-long runs use the standalone runner:
 *
 *   ./e2e/prod-soak.sh --duration 3600 --target all
 *   ./e2e/prod-soak.sh --duration 0 --target all       # until Ctrl-C
 *
 * Gated so `all`/`remaining` never hit production:
 *   E2E_PROD_SOAK=1 ./e2e/e2etest.sh p2p-prod-soak
 */
const ready = process.env.E2E_PROD_SOAK === '1';
const seconds = process.env.E2E_PROD_SOAK_SECONDS || '30';
const target = process.env.E2E_PROD_SOAK_TARGET || 'p2p';
const concurrency = process.env.E2E_PROD_SOAK_CONCURRENCY || '2';

test.describe('P2P production soak', () => {
  test.skip(!ready, 'prod soak part not running (E2E_PROD_SOAK=1)');

  test('short soak pass stays within the error/latency/stability budget', async () => {
    test.setTimeout(180_000);
    const root = path.resolve(__dirname, '..', '..', '..');
    const runner = path.join(root, 'e2e', 'prod-soak.mjs');
    const out = path.join(
      __dirname,
      '..',
      '..',
      'test-results',
      `prod-soak-smoke-${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });

    let stdout = '';
    let stderr = '';
    let status = 0;
    try {
      stdout = execFileSync(
        process.execPath,
        [
          runner,
          '--target', target,
          '--duration', seconds,
          '--warmup', '5',
          '--concurrency', concurrency,
          '--interval', process.env.E2E_PROD_SOAK_INTERVAL_MS || '500',
          '--out', out,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 150_000,
          env: {
            ...process.env,
            E2E_PROD_L0_URL: process.env.E2E_PROD_L0_URL || 'https://eu1.bigtangle.org',
            E2E_PROD_L1_SOCIAL_URL:
              process.env.E2E_PROD_L1_SOCIAL_URL || 'https://socialeu1.bigtangle.org',
            E2E_PROD_L1_ORDER_URL:
              process.env.E2E_PROD_L1_ORDER_URL || 'https://ordereu1.bigtangle.org',
            E2E_PROD_P2P_URL:
              process.env.E2E_PROD_P2P_URL || 'https://eu.wallet.bigt.ai/p2p',
          },
        },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1;
      stdout = err.stdout || '';
      stderr = err.stderr || '';
    }

    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    // Surface the runner summary in the Playwright output on failure.
    if (!report.passed) {
      console.error(stdout);
      console.error(stderr);
    }
    expect(
      report.passed,
      `soak failed (exit ${status}): ${(report.failures || []).join('; ')}`,
    ).toBe(true);
    expect(report.requests).toBeGreaterThan(0);
    expect(report.errorRate).toBeLessThanOrEqual(0.05);
    expect(report.stability?.finalWatch?.lastError ?? null).toBeNull();
  });
});
