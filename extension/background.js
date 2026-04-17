/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tidy Tabby.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Native Messaging Terminal Relay ─────────────────────────────────────────

const NATIVE_HOST = 'com.tidytabby.terminal';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'terminal') return;

  let nativePort = null;
  let connected = false;

  // Connect to native host
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);

  // Relay native host output → extension page
  nativePort.onMessage.addListener((msg) => {
    if (!connected) {
      connected = true;
      port.postMessage({ type: 'connected' });
    }
    try { port.postMessage(msg); } catch {}
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'Native host disconnected';
    console.warn('[tidy-tabby] Native host disconnect:', error);
    try { port.postMessage({ type: 'disconnected', data: error }); } catch {}
    nativePort = null;
  });

  // Relay extension page input → native host
  port.onMessage.addListener((msg) => {
    if (nativePort) {
      try { nativePort.postMessage(msg); } catch {}
    }
  });

  port.onDisconnect.addListener(() => {
    if (nativePort) {
      try { nativePort.disconnect(); } catch {}
      nativePort = null;
    }
  });
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
