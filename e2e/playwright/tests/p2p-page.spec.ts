import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

/**
 * P2P trading page (sources/screens/p2p/P2pScreen.tsx).
 *
 * The page is reachable from the sidebar (label "P2P") and either shows the
 * order book / create form (when EXPO_PUBLIC_P2P_ENGINE_URL is baked into the
 * web build) or a not-configured notice (the default e2e build, where
 * IS_DEV is false and no engine URL is set). Both are valid mounts; the smoke
 * test asserts the route renders and the edge state is handled, not a stub.
 */
test.describe('P2P Page', () => {
  test('navigates from the sidebar and mounts the P2P screen', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'P2P');
    const mounted = page.locator('[data-testid="p2p-not-configured"], [data-testid="p2p-tab-open"]').first();
    await expect(mounted).toBeAttached({ timeout: 10000 });
  });

  test('shows the not-configured notice when no engine is baked in', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'P2P');
    const tab = await getElement(page, 'p2p-tab-open');
    // The default e2e web build has no engine URL: assert the deterministic
    // edge state. If a build with an engine is used, assert the tabs instead.
    if ((await tab.count()) > 0) {
      await expect(tab).toBeAttached();
      await expect(await getElement(page, 'p2p-create')).toBeAttached({ timeout: 10000 });
    } else {
      await expect(await getElement(page, 'p2p-not-configured')).toBeAttached({ timeout: 10000 });
    }
  });
});
