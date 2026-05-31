/**
 * E2E Test Setup Helpers
 */

import { device, element, by, expect as detoxExpect, waitFor } from 'detox';

/**
 * Wait for element to be visible with timeout
 */
export async function waitForElementToBeVisible(
  matcher: Detox.NativeMatcher,
  timeout: number = 10000
) {
  await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
}

/**
 * Wait for element to exist with timeout
 */
export async function waitForElementToExist(
  matcher: Detox.NativeMatcher,
  timeout: number = 10000
) {
  await waitFor(element(matcher)).toExist().withTimeout(timeout);
}

/**
 * Tap on element by test ID
 */
export async function tapByTestId(testId: string) {
  await element(by.id(testId)).tap();
}

/**
 * Type text into element by test ID
 */
export async function typeTextByTestId(testId: string, text: string) {
  await element(by.id(testId)).typeText(text);
}

/**
 * Clear text from element by test ID
 */
export async function clearTextByTestId(testId: string) {
  await element(by.id(testId)).clearText();
}

/**
 * Scroll to element and tap
 */
export async function scrollToAndTap(
  scrollViewTestId: string,
  elementTestId: string,
  direction: 'up' | 'down' = 'down'
) {
  await waitFor(element(by.id(elementTestId)))
    .toBeVisible()
    .whileElement(by.id(scrollViewTestId))
    .scroll(100, direction);

  await element(by.id(elementTestId)).tap();
}

/**
 * Wait for app to be ready (splash screen to disappear)
 */
export async function waitForAppToBeReady() {
  // Wait for the main navigation to be visible
  await waitForElementToExist(by.id('tab-navigation'), 15000);
}

/**
 * Navigate to tab by index
 */
export async function navigateToTab(tabIndex: number) {
  await element(by.id(`tab-${tabIndex}`)).tap();
}

/**
 * Navigate to specific tab by name
 */
export async function navigateToTabByName(tabName: string) {
  await element(by.text(tabName)).tap();
}

/**
 * Take screenshot with name
 */
export async function takeScreenshot(name: string) {
  if (device.getPlatform() === 'ios') {
    await device.takeScreenshot(name);
  }
}

/**
 * Reload React Native
 */
export async function reloadReactNative() {
  await device.reloadReactNative();
}

/**
 * Clear app data and restart
 */
export async function resetApp() {
  await device.launchApp({ delete: true });
  await waitForAppToBeReady();
}

/**
 * Check if element exists
 */
export async function elementExists(testId: string): Promise<boolean> {
  try {
    await detoxExpect(element(by.id(testId))).toExist();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if element is visible
 */
export async function elementIsVisible(testId: string): Promise<boolean> {
  try {
    await detoxExpect(element(by.id(testId))).toBeVisible();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Wait for modal to appear
 */
export async function waitForModal(modalTestId: string = 'modal') {
  await waitForElementToBeVisible(by.id(modalTestId), 5000);
}

/**
 * Dismiss modal by tapping backdrop or close button
 */
export async function dismissModal(closeButtonTestId: string = 'modal-close') {
  try {
    await element(by.id(closeButtonTestId)).tap();
  } catch (e) {
    // Try tapping backdrop if close button not found
    await element(by.id('modal-backdrop')).tap();
  }
}

/**
 * Accept alert dialog
 */
export async function acceptAlert() {
  if (device.getPlatform() === 'ios') {
    await element(by.label('OK')).tap();
  } else {
    await element(by.text('OK')).tap();
  }
}

/**
 * Dismiss alert dialog
 */
export async function dismissAlert() {
  if (device.getPlatform() === 'ios') {
    await element(by.label('Cancel')).tap();
  } else {
    await element(by.text('Cancel')).tap();
  }
}

/**
 * Swipe element
 */
export async function swipe(
  testId: string,
  direction: 'left' | 'right' | 'up' | 'down',
  speed: 'fast' | 'slow' = 'fast',
  percentage: number = 0.75
) {
  await element(by.id(testId)).swipe(direction, speed, percentage);
}

/**
 * Long press element
 */
export async function longPress(testId: string, duration: number = 1000) {
  await element(by.id(testId)).longPress(duration);
}

/**
 * Scroll element to edge
 */
export async function scrollToEdge(
  testId: string,
  edge: 'top' | 'bottom' | 'left' | 'right'
) {
  await element(by.id(testId)).scrollTo(edge);
}

/**
 * Wait for network request to complete
 */
export async function waitForNetwork(timeMs: number = 2000) {
  await new Promise((resolve) => setTimeout(resolve, timeMs));
}

/**
 * Set device orientation
 */
export async function setOrientation(orientation: 'portrait' | 'landscape') {
  await device.setOrientation(orientation);
}

/**
 * Send app to background and bring back
 */
export async function sendToBackgroundAndResume(duration: number = 3000) {
  await device.sendToHome();
  await new Promise((resolve) => setTimeout(resolve, duration));
  await device.launchApp({ newInstance: false });
}

/**
 * Grant permissions via launch app
 */
export async function grantPermissions(permissions: string[]) {
  if (device.getPlatform() === 'ios') {
    await device.launchApp({
      permissions: {
        camera: 'YES',
        notifications: 'YES',
        ...permissions.reduce((acc, p) => ({ ...acc, [p]: 'YES' }), {}),
      },
    });
  }
}
