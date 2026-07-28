import { test, expect } from "@playwright/test";

/**
 * Wallet Demo — Screenshot-based visual tests.
 *
 * Pattern: inject mock HTML into the page (no wallet, no server needed).
 * Each step shows a realistic wallet UI and takes a screenshot.
 *
 * Based on ../bigtai/tests/demo/order/order.spec.ts
 */

const SCREENSHOT_DIR = "demo-output/screenshots";

// ── Transaction screen: No wallet state ─────────────────────────
const noWalletHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;display:flex;flex-direction:column;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Transaction</div>
    <div style="margin-left:auto;width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;">
    <div style="width:48px;height:48px;background:#e5e5e5;border-radius:24px;margin-bottom:12px;"></div>
    <div style="font-size:20px;font-weight:700;color:#1c1c1e;margin-bottom:8px;">No Wallet Found</div>
    <div style="font-size:14px;color:#8e8e93;margin-bottom:24px;line-height:20px;">Create or import a wallet to start sending payments</div>
    <div style="background:#10a37f;color:#fff;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;margin-bottom:10px;width:200px;text-align:center;">Create Wallet</div>
    <div style="border:1px solid #e5e5e5;color:#8e8e93;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:600;width:200px;text-align:center;">Import Wallet</div>
  </div>
</div>`;

const lockedWalletHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;display:flex;flex-direction:column;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Transaction</div>
    <div style="margin-left:auto;width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;">
    <div style="width:48px;height:48px;background:#e5e5e5;border-radius:24px;margin-bottom:12px;"></div>
    <div style="font-size:20px;font-weight:700;color:#1c1c1e;margin-bottom:8px;">Wallet Locked</div>
    <div style="font-size:14px;color:#8e8e93;margin-bottom:8px;line-height:20px;">Unlock your wallet to send payments</div>
    <div style="font-size:12px;color:#8e8e93;font-family:monospace;margin-bottom:12px;">Wallet: mjWvzPZz4Y...</div>
    <div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;font-size:15px;color:#000;width:280px;margin-bottom:12px;background:#fff;">Enter wallet password</div>
    <div style="background:#10a37f;color:#fff;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;width:200px;text-align:center;">Unlock Wallet</div>
  </div>
</div>`;

const walletScreenHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Wallet</div>
    <div style="margin-left:auto;width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
  </div>
  <div style="padding:20px;">
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e5e5;padding:16px;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:600;color:#8e8e93;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Your Address</div>
      <div style="font-size:13px;color:#000;font-family:monospace;line-height:18px;">mjWvzPZz4YJtWqb7ux7cdgq5G7rzkg3bXG</div>
      <div style="height:1px;background:#e5e5e5;margin:12px 0;"></div>
      <div style="font-size:14px;color:#10a37f;font-weight:600;">Manage Keys</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="font-size:16px;font-weight:700;color:#000;">Assets</div>
      <div style="font-size:14px;color:#10a37f;font-weight:600;">Refresh</div>
    </div>
    <div style="background:#fff;border-radius:10px;border:1px solid #e5e5e5;padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:8px;height:8px;border-radius:4px;background:#10a37f;"></div>
        <div><div style="font-size:15px;font-weight:600;color:#000;">BIG</div><div style="font-size:11px;color:#8e8e93;font-family:monospace;">bc...</div></div>
      </div>
      <div style="font-size:16px;font-weight:700;color:#000;">100000000</div>
    </div>
  </div>
</div>`;

const marketHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Market</div>
  </div>
  <div style="margin:12px 16px;display:flex;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="flex:1;padding:10px;text-align:center;background:#10a37f;color:#fff;font-size:14px;font-weight:600;">Market</div>
    <div style="flex:1;padding:10px;text-align:center;background:#fff;color:#8e8e93;font-size:14px;font-weight:600;">My Orders</div>
  </div>
  <div style="padding:0 16px;">
    ${[ 
      {n:"BIG", p:"0.000042", c:"+2.34", id:"bc"},
      {n:"USDC", p:"1.0001", c:"+0.01", id:"usdc"},
      {n:"ETH", p:"0.052", c:"-1.20", id:"eth"},
    ].map(t => `
    <div style="background:#fff;border-radius:10px;border:1px solid #e5e5e5;padding:12px;margin-bottom:8px;display:flex;align-items:center;">
      <div style="flex:1;"><div style="font-size:15px;font-weight:600;color:#000;">${t.n}</div><div style="font-size:11px;color:#8e8e93;font-family:monospace;">${t.id}...</div></div>
      <div style="text-align:right;margin-right:10px;"><div style="font-size:15px;font-weight:700;color:#000;">$${t.p}</div><div style="font-size:12px;font-weight:600;color:${t.c.startsWith('+')?'#10b981':'#ef4444'};">${t.c}</div></div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="background:#10b981;border-radius:6px;padding:5px 14px;text-align:center;"><span style="color:#fff;font-size:12px;font-weight:700;">Buy</span></div>
        <div style="background:#ef4444;border-radius:6px;padding:5px 14px;text-align:center;"><span style="color:#fff;font-size:12px;font-weight:700;">Sell</span></div>
      </div>
    </div>`).join('')}
  </div>
</div>`;

const tokensHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Tokens</div>
  </div>
  <div style="margin:12px 16px;display:flex;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;">
    <div style="flex:1;padding:10px;text-align:center;background:#10a37f;color:#fff;font-size:14px;font-weight:600;">Tokens</div>
    <div style="flex:1;padding:10px;text-align:center;background:#fff;color:#8e8e93;font-size:14px;font-weight:600;">Create</div>
  </div>
  <div style="padding:0 16px;">
    <div style="border:1px solid #e5e5e5;border-radius:10px;padding:12px;font-size:14px;background:#fff;color:#000;margin-bottom:16px;">Search by name or ID</div>
    ${[ 
      {n:"BigTangle", id:"bc", d:"BigTangle Currency"},
      {n:"USD Coin", id:"usdc", d:"USD stablecoin"},
    ].map(t => `
    <div style="background:#fff;border-radius:10px;border:1px solid #e5e5e5;padding:14px;margin-bottom:8px;display:flex;align-items:center;">
      <div style="width:8px;height:8px;border-radius:4px;background:#3b82f6;margin-right:12px;"></div>
      <div style="flex:1;"><div style="font-size:15px;font-weight:600;color:#000;">${t.n}</div><div style="font-size:11px;color:#8e8e93;font-family:monospace;">${t.id}...</div><div style="font-size:12px;color:#8e8e93;">${t.d}</div></div>
    </div>`).join('')}
  </div>
</div>`;

const settingsHtml = `
<div style="max-width:420px;margin:20px auto;background:#f5f5f5;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:700px;">
  <div style="background:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e5e5;">
    <div style="width:24px;height:24px;background:#e5e5e5;border-radius:4px;"></div>
    <div style="font-size:17px;font-weight:600;color:#000;">Settings</div>
  </div>
  <div style="padding:16px;">
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e5e5;padding:16px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><div style="font-size:15px;font-weight:600;color:#000;">Testnet</div><div style="font-size:12px;color:#8e8e93;">Connect to test network</div></div>
        <div style="width:50px;height:28px;background:#10a37f;border-radius:14px;position:relative;"><div style="width:24px;height:24px;background:#fff;border-radius:12px;position:absolute;right:2px;top:2px;"></div></div>
      </div>
    </div>
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e5e5;padding:16px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:#8e8e93;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Server URL</div>
      <div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;font-size:13px;font-family:monospace;color:#000;background:#f5f5f5;margin-bottom:10px;">https://testp.bigtangle.org:8088/</div>
      <div style="background:#10a37f;border-radius:8px;padding:10px;text-align:center;"><span style="color:#fff;font-size:14px;font-weight:600;">Save</span></div>
    </div>
    <div style="background:#fff;border-radius:12px;border:1px solid #e5e5e5;padding:16px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:#8e8e93;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">About</div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="font-size:14px;color:#8e8e93;">App Version</span><span style="font-size:14px;font-weight:600;color:#000;">1.2.0</span></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="font-size:14px;color:#8e8e93;">Network</span><span style="font-size:14px;font-weight:600;color:#000;">Testnet</span></div>
    </div>
    <div style="border-radius:10px;border:1px solid #ef4444;padding:13px;text-align:center;"><span style="font-size:14px;font-weight:600;color:#ef4444;">Reset to Defaults</span></div>
  </div>
</div>`;

test.describe("Wallet Demo Screenshots", () => {
  test.setTimeout(60000);

  test("capture all wallet screen mockups", async ({ page }) => {
    const shots: { name: string; html: string; desc: string }[] = [
      { name: "01-transaction-no-wallet", html: noWalletHtml, desc: "Transaction screen with no wallet" },
      { name: "02-transaction-locked", html: lockedWalletHtml, desc: "Transaction screen with locked wallet (inline unlock)" },
      { name: "03-wallet-assets", html: walletScreenHtml, desc: "Wallet screen showing address and BIG balance" },
      { name: "04-market-prices", html: marketHtml, desc: "Market screen with BUY/SELL buttons" },
      { name: "05-tokens-browse", html: tokensHtml, desc: "Tokens browser with search" },
      { name: "06-settings", html: settingsHtml, desc: "Settings with testnet toggle" },
    ];

    for (const shot of shots) {
      await page.setContent(shot.html, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      const path = `${SCREENSHOT_DIR}/${shot.name}.png`;
      await page.screenshot({ path, fullPage: false });
      console.log(`  ✓ ${shot.name}.png — ${shot.desc}`);
    }
  });
});
