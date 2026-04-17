/* ================================================================
   Tidy Tabby — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tidy Tabby's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tidy Tabby new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tidy Tabby tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tidy Tabby pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tidy Tabby tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   PRIVACY MODE — hide dashboard content during screen sharing

   Toggle with:
   - The lock icon button in the header
   - The Esc key
   State is persisted in chrome.storage.local so it survives new tabs.
   ---------------------------------------------------------------- */

// ---- Privacy mode storage ----

const PRIVACY_DEFAULTS = { clock: true, date: true, motto: true, search: true, mottoText: '' };

async function getPrivacyMode() {
  try {
    const result = await chrome.storage.local.get('privacyMode');
    return result.privacyMode === true;
  } catch {
    return false;
  }
}

async function getPrivacySettings() {
  try {
    const result = await chrome.storage.local.get('privacySettings');
    return { ...PRIVACY_DEFAULTS, ...result.privacySettings };
  } catch {
    return { ...PRIVACY_DEFAULTS };
  }
}

async function savePrivacySettings(settings) {
  try { await chrome.storage.local.set({ privacySettings: settings }); } catch {}
}

async function setPrivacyMode(enabled) {
  try { await chrome.storage.local.set({ privacyMode: enabled }); } catch {}
  document.body.classList.toggle('privacy-mode', enabled);
  if (enabled) { applyPrivacyWidgets(); startPrivacyClock(); } else stopPrivacyClock();
}

// ---- Apply widget visibility from settings ----

async function applyPrivacyWidgets() {
  const s = await getPrivacySettings();
  const timeEl   = document.getElementById('privacyTime');
  const dateEl   = document.getElementById('privacyDate');
  const mottoEl  = document.getElementById('privacyMotto');
  const searchEl = document.getElementById('privacySearch');

  if (timeEl)   timeEl.style.display   = s.clock  ? '' : 'none';
  if (dateEl)   dateEl.style.display   = s.date   ? '' : 'none';
  if (searchEl) searchEl.style.display = s.search ? '' : 'none';
  if (mottoEl) {
    mottoEl.style.display = s.motto && s.mottoText ? '' : 'none';
    mottoEl.textContent   = s.mottoText || '';
  }

  // Sync settings panel checkboxes
  const ids = { psClock: 'clock', psDate: 'date', psMotto: 'motto', psSearch: 'search' };
  for (const [elId, key] of Object.entries(ids)) {
    const cb = document.getElementById(elId);
    if (cb) cb.checked = s[key];
  }
  const mottoInput = document.getElementById('psMottoInput');
  if (mottoInput) mottoInput.value = s.mottoText || '';
  const mottoEdit = document.getElementById('psMottoEdit');
  if (mottoEdit) mottoEdit.style.display = s.motto ? '' : 'none';
}

// ---- Live clock ----
let privacyClockInterval = null;

function updatePrivacyClock() {
  const now = new Date();
  const timeEl = document.getElementById('privacyTime');
  const dateEl = document.getElementById('privacyDate');
  if (timeEl) {
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }
}

function startPrivacyClock() {
  updatePrivacyClock();
  if (!privacyClockInterval) {
    privacyClockInterval = setInterval(updatePrivacyClock, 1000);
  }
}

function stopPrivacyClock() {
  if (privacyClockInterval) {
    clearInterval(privacyClockInterval);
    privacyClockInterval = null;
  }
}

// ---- Toggle privacy mode ----

async function togglePrivacyMode() {
  const current = document.body.classList.contains('privacy-mode');
  await setPrivacyMode(!current);
}

document.getElementById('privacyToggle')?.addEventListener('click', togglePrivacyMode);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Don't toggle if user is typing in search or motto input
    const active = document.activeElement;
    if (active && (active.id === 'privacySearchInput' || active.id === 'psMottoInput')) {
      active.blur();
      return;
    }
    e.preventDefault();
    togglePrivacyMode();
  }
});

// ---- Settings panel ----

document.getElementById('privacySettingsBtn')?.addEventListener('click', () => {
  const panel = document.getElementById('privacySettings');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

// Close settings when clicking outside
document.addEventListener('click', (e) => {
  const panel = document.getElementById('privacySettings');
  const btn   = document.getElementById('privacySettingsBtn');
  if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.style.display = 'none';
  }
});

// Settings checkbox changes
for (const id of ['psClock', 'psDate', 'psMotto', 'psSearch']) {
  document.getElementById(id)?.addEventListener('change', async () => {
    const s = await getPrivacySettings();
    s.clock  = document.getElementById('psClock')?.checked ?? true;
    s.date   = document.getElementById('psDate')?.checked ?? true;
    s.motto  = document.getElementById('psMotto')?.checked ?? true;
    s.search = document.getElementById('psSearch')?.checked ?? true;
    await savePrivacySettings(s);
    applyPrivacyWidgets();
  });
}

// Motto text input (save on blur or Enter)
const mottoInput = document.getElementById('psMottoInput');
if (mottoInput) {
  const saveMotto = async () => {
    const s = await getPrivacySettings();
    s.mottoText = mottoInput.value.trim();
    await savePrivacySettings(s);
    applyPrivacyWidgets();
  };
  mottoInput.addEventListener('blur', saveMotto);
  mottoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mottoInput.blur(); } });
}

// ---- Init ----

async function initPrivacyMode() {
  const enabled = await getPrivacyMode();
  if (enabled) {
    document.body.classList.add('privacy-mode');
    await applyPrivacyWidgets();
    startPrivacyClock();
  }
}


/* ----------------------------------------------------------------
   BOOKMARKS — read Chrome bookmarks and display organized view
   ---------------------------------------------------------------- */

// ---- Fetch all bookmarks from Chrome ----

async function fetchBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    return tree;
  } catch {
    return [];
  }
}

/**
 * flattenBookmarks(nodes, path)
 *
 * Recursively walks the bookmark tree and returns a flat array of
 * { title, url, folder, folderPath, dateAdded }.
 */
function flattenBookmarks(nodes, path = [], parentId = null) {
  const results = [];
  for (const node of nodes) {
    if (node.url) {
      results.push({
        id: node.id,
        parentId: node.parentId || parentId,
        title: node.title || node.url,
        url: node.url,
        folder: path.length > 0 ? path[path.length - 1] : 'Other',
        folderPath: path.join(' / ') || 'Other',
        dateAdded: node.dateAdded || 0,
      });
    }
    if (node.children) {
      const folderName = node.title || '';
      const newPath = folderName ? [...path, folderName] : path;
      results.push(...flattenBookmarks(node.children, newPath, node.id));
    }
  }
  return results;
}

/**
 * collectFolders(nodes, path)
 *
 * Recursively collects all bookmark folders as { id, title, path }.
 */
function collectFolders(nodes, path = []) {
  const results = [];
  for (const node of nodes) {
    if (node.children) {
      const folderName = node.title || '';
      const newPath = folderName ? [...path, folderName] : path;
      if (folderName) {
        results.push({ id: node.id, title: folderName, path: newPath.join(' / ') });
      }
      results.push(...collectFolders(node.children, newPath));
    }
  }
  return results;
}

/**
 * suggestFolderName(url, title)
 *
 * Suggests a folder name for a bookmark based on its URL domain and content.
 */
function suggestFolderName(url, title) {
  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }

  // Category mappings based on domain patterns
  const categories = {
    'Dev':        ['github.com', 'stackoverflow.com', 'npmjs.com', 'developer.mozilla.org', 'codepen.io', 'gitlab.com', 'bitbucket.org', 'dev.to', 'medium.com'],
    'AI & ML':    ['huggingface.co', 'arxiv.org', 'openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com', 'kaggle.com'],
    'Social':     ['x.com', 'twitter.com', 'reddit.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'threads.net', 'mastodon.social'],
    'News':       ['news.ycombinator.com', 'techcrunch.com', 'theverge.com', 'arstechnica.com', 'bbc.com', 'cnn.com', 'reuters.com', 'nytimes.com'],
    'Video':      ['youtube.com', 'vimeo.com', 'twitch.tv', 'netflix.com', 'bilibili.com'],
    'Shopping':   ['amazon.com', 'ebay.com', 'etsy.com', 'shopify.com', 'taobao.com'],
    'Design':     ['figma.com', 'dribbble.com', 'behance.net', 'canva.com', 'fonts.google.com'],
    'Docs':       ['docs.google.com', 'notion.so', 'confluence.atlassian.net', 'dropbox.com', 'drive.google.com'],
    'Music':      ['spotify.com', 'music.youtube.com', 'soundcloud.com', 'music.apple.com'],
    'Productivity': ['calendar.google.com', 'mail.google.com', 'slack.com', 'discord.com', 'trello.com', 'asana.com', 'linear.app'],
    'Reference':  ['wikipedia.org', 'en.wikipedia.org', 'wikimedia.org', 'dictionary.com', 'mdn.io'],
  };

  for (const [category, domains] of Object.entries(categories)) {
    if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
      return category;
    }
  }

  // Fallback: use the friendly domain name
  return friendlyDomain(hostname);
}

/**
 * groupBookmarksByFolder(bookmarks)
 *
 * Groups flat bookmarks by their immediate folder name.
 * Returns sorted array of { folder, folderPath, bookmarks: [] }.
 */
function groupBookmarksByFolder(bookmarks) {
  const map = {};
  for (const bm of bookmarks) {
    const key = bm.folderPath || 'Other';
    if (!map[key]) map[key] = { folder: bm.folder, folderPath: key, bookmarks: [] };
    map[key].bookmarks.push(bm);
  }
  return Object.values(map).sort((a, b) => b.bookmarks.length - a.bookmarks.length);
}

/**
 * generateBookmarkSuggestions(bookmarks)
 *
 * Analyzes bookmarks and generates useful insights:
 * - Potential duplicates
 * - Stale bookmarks (old, maybe outdated)
 * - Already-open bookmarks
 * - Domain stats
 */
function generateBookmarkSuggestions(bookmarks) {
  const suggestions = [];

  // Find duplicates (same URL)
  const urlCounts = {};
  for (const bm of bookmarks) {
    const normalized = bm.url.replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
    urlCounts[normalized] = (urlCounts[normalized] || 0) + 1;
  }
  const dupeCount = Object.values(urlCounts).filter(c => c > 1).length;
  if (dupeCount > 0) {
    suggestions.push({
      type: 'warning',
      text: `${dupeCount} duplicate bookmark${dupeCount > 1 ? 's' : ''} found — same URL saved in multiple folders.`,
    });
  }

  // Find bookmarks that are already open as tabs
  const openUrls = new Set(openTabs.map(t => t.url));
  const alreadyOpen = bookmarks.filter(bm => openUrls.has(bm.url));
  if (alreadyOpen.length > 0) {
    suggestions.push({
      type: 'info',
      text: `${alreadyOpen.length} bookmark${alreadyOpen.length > 1 ? 's are' : ' is'} already open as tab${alreadyOpen.length > 1 ? 's' : ''}.`,
    });
  }

  // Domain breakdown — top 3 domains
  const domainCounts = {};
  for (const bm of bookmarks) {
    try {
      const hostname = new URL(bm.url).hostname.replace(/^www\./, '');
      domainCounts[hostname] = (domainCounts[hostname] || 0) + 1;
    } catch {}
  }
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topDomains.length > 0) {
    const parts = topDomains.map(([d, c]) => `${friendlyDomain(d)} (${c})`);
    suggestions.push({
      type: 'stat',
      text: `Top sites: ${parts.join(', ')}.`,
    });
  }

  // Old bookmarks (> 1 year)
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const oldCount = bookmarks.filter(bm => bm.dateAdded && bm.dateAdded < oneYearAgo).length;
  if (oldCount > 10) {
    suggestions.push({
      type: 'cleanup',
      text: `${oldCount} bookmarks are over a year old — might be worth reviewing.`,
    });
  }

  return suggestions;
}

/**
 * renderBookmarkCard(group)
 *
 * Renders one folder group card, similar to domain cards for open tabs.
 */
function renderBookmarkCard(group) {
  const count = group.bookmarks.length;
  const stableId = 'bm-folder-' + group.folderPath.replace(/[^a-z0-9]/gi, '-').toLowerCase();

  const visibleBookmarks = group.bookmarks.slice(0, 6);
  const extraCount = count - visibleBookmarks.length;

  const chips = visibleBookmarks.map(bm => renderBookmarkChip(bm)).join('');

  const overflowHtml = extraCount > 0 ? renderBookmarkOverflow(group.bookmarks.slice(6)) : '';

  return `
    <div class="mission-card bookmark-card has-neutral-bar" data-folder-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${group.folder}</span>
          <span class="open-tabs-badge" style="color:var(--accent-slate);background:rgba(90,107,122,0.08);">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="10" height="10"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
            ${count} bookmark${count !== 1 ? 's' : ''}
          </span>
        </div>
        ${group.folderPath !== group.folder ? `<div class="bookmark-folder-path">${group.folderPath}</div>` : ''}
        <div class="mission-pages">${chips}${overflowHtml}</div>
      </div>
    </div>`;
}

function renderBookmarkChip(bm) {
  const label = stripTitleNoise(bm.title || '');
  let domain = '';
  try { domain = new URL(bm.url).hostname; } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
  const safeUrl = (bm.url || '').replace(/"/g, '&quot;');
  const safeTitle = label.replace(/"/g, '&quot;');
  const isOpen = openTabs.some(t => t.url === bm.url);
  const openIndicator = isOpen ? ' <span class="bookmark-open-indicator" title="Already open">●</span>' : '';

  return `<div class="page-chip clickable" data-action="open-bookmark" data-tab-url="${safeUrl}" data-bm-id="${bm.id}" title="${safeTitle}">
    ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
    <span class="chip-text">${label}${openIndicator}</span>
    <div class="chip-actions">
      <button class="chip-action chip-move" data-action="move-bookmark" data-bm-id="${bm.id}" data-bm-url="${safeUrl}" data-bm-title="${safeTitle}" title="Move to folder">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="delete-bookmark" data-bm-id="${bm.id}" title="Delete bookmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>`;
}

function renderBookmarkOverflow(hiddenBookmarks) {
  const hiddenChips = hiddenBookmarks.map(bm => renderBookmarkChip(bm)).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenBookmarks.length} more</span>
    </div>`;
}

/* ---- Bookmark AI — API key + Claude call ---- */

async function getBookmarkApiKey() {
  try {
    const result = await chrome.storage.local.get('anthropicApiKey');
    return result.anthropicApiKey || '';
  } catch { return ''; }
}

async function saveBookmarkApiKey(key) {
  try { await chrome.storage.local.set({ anthropicApiKey: key }); } catch {}
}

function buildBookmarkSummary(bookmarks, folders) {
  let summary = `The user has ${bookmarks.length} bookmarks across ${folders.length} folders:\n\n`;

  const groups = groupBookmarksByFolder(bookmarks);
  for (const g of groups) {
    summary += `[${g.folderPath}] (${g.bookmarks.length} bookmarks)\n`;
    for (const bm of g.bookmarks.slice(0, 10)) {
      summary += `  - ${bm.title} | ${bm.url}\n`;
    }
    if (g.bookmarks.length > 10) {
      summary += `  ... and ${g.bookmarks.length - 10} more\n`;
    }
    summary += '\n';
  }
  return summary;
}

async function callClaudeForBookmarks(bookmarks, folders) {
  const apiKey = await getBookmarkApiKey();
  if (!apiKey) throw new Error('No API key');

  const systemPrompt = `You are a bookmark organizer assistant. The user will show you their browser bookmarks. Analyze them and provide:

1. **Folder suggestions**: Recommend how to reorganize messy or uncategorized bookmarks into logical folders. Be specific — name the bookmark and the suggested folder.
2. **Duplicates**: Point out any duplicate or near-duplicate bookmarks.
3. **Cleanup candidates**: Identify bookmarks that look outdated, broken (common patterns), or low-value.
4. **Themes**: Briefly note what topics/interests the bookmarks reveal.

Be concise and actionable. Use short bullet points. Don't repeat the full URLs — use the bookmark titles. Respond in the same language as the bookmark titles (if mostly Chinese, respond in Chinese; if mostly English, respond in English).`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildBookmarkSummary(bookmarks, folders) }],
    }),
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new Error('Invalid API key');
    throw new Error(`API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || 'No response.';
}

// ---- AI button wiring ----

async function initBookmarkAi() {
  const apiKey = await getBookmarkApiKey();
  const keyRow = document.getElementById('bookmarkAiKeyRow');
  const btn = document.getElementById('bookmarkAiBtn');

  if (!apiKey) {
    // Show key input, hide button
    if (keyRow) keyRow.style.display = '';
    if (btn) btn.style.display = 'none';
  } else {
    if (keyRow) keyRow.style.display = 'none';
    if (btn) btn.style.display = '';
  }
}

document.getElementById('bookmarkAiKeySave')?.addEventListener('click', async () => {
  const input = document.getElementById('bookmarkAiKeyInput');
  const key = input?.value.trim();
  if (!key) return;
  await saveBookmarkApiKey(key);
  await initBookmarkAi();
});

document.getElementById('bookmarkAiKeyInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('bookmarkAiKeySave')?.click(); }
});

document.getElementById('bookmarkAiBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('bookmarkAiBtn');
  const responseEl = document.getElementById('bookmarkAiResponse');
  const section = document.getElementById('bookmarksSection');
  if (!btn || !responseEl || !section) return;

  const bookmarks = section._allBookmarks || [];
  const folders = section._folders || [];
  if (bookmarks.length === 0) return;

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  responseEl.style.display = '';
  responseEl.innerHTML = '<div class="bookmark-ai-loading">Thinking...</div>';

  try {
    const reply = await callClaudeForBookmarks(bookmarks, folders);
    // Simple markdown-ish rendering: bold, bullets, headers
    const html = reply
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^### (.+)$/gm, '<div class="bookmark-ai-heading">$1</div>')
      .replace(/^## (.+)$/gm, '<div class="bookmark-ai-heading">$1</div>')
      .replace(/^[-*] (.+)$/gm, '<div class="bookmark-ai-bullet">$1</div>')
      .replace(/\n{2,}/g, '<br>')
      .replace(/\n/g, '<br>');
    responseEl.innerHTML = `<div class="bookmark-ai-result">${html}</div>`;
  } catch (err) {
    responseEl.innerHTML = `<div class="bookmark-ai-error">${err.message === 'Invalid API key' ? 'Invalid API key. Click to re-enter.' : 'Error: ' + err.message}</div>`;
    if (err.message === 'Invalid API key') {
      await saveBookmarkApiKey('');
      await initBookmarkAi();
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg> Organize with AI`;
  }
});

/**
 * renderBookmarksSection()
 *
 * Main entry point: fetches bookmarks, groups them, generates
 * suggestions, and renders everything.
 */
async function renderBookmarksSection() {
  const section = document.getElementById('bookmarksSection');
  if (!section) return;

  const tree = await fetchBookmarks();
  const allBookmarks = flattenBookmarks(tree);

  if (allBookmarks.length === 0) {
    return;
  }

  // Count
  const countEl = document.getElementById('bookmarksCount');
  const groups = groupBookmarksByFolder(allBookmarks);
  if (countEl) {
    countEl.textContent = `${allBookmarks.length} bookmarks · ${groups.length} folders`;
  }

  // Suggestions
  const suggestions = generateBookmarkSuggestions(allBookmarks);
  const suggestionsEl = document.getElementById('bookmarkSuggestions');
  const suggestionsBody = document.getElementById('bookmarkSuggestionsBody');
  if (suggestions.length > 0 && suggestionsEl && suggestionsBody) {
    suggestionsBody.innerHTML = suggestions.map(s => {
      const icon = s.type === 'warning' ? '⚠' : s.type === 'info' ? '↗' : s.type === 'cleanup' ? '🧹' : '📊';
      return `<div class="bookmark-suggestion-item">${icon} ${s.text}</div>`;
    }).join('');
    suggestionsEl.style.display = '';
  }

  // Render folder cards
  const foldersEl = document.getElementById('bookmarkFolders');
  if (foldersEl) {
    foldersEl.innerHTML = groups.map(g => renderBookmarkCard(g)).join('');
  }

  // Store for search and management
  section._allBookmarks = allBookmarks;
  section._groups = groups;
  section._folderTree = tree;
  section._folders = collectFolders(tree);
}

// ---- Bookmark search ----
document.addEventListener('input', (e) => {
  if (e.target.id !== 'bookmarkSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const section = document.getElementById('bookmarksSection');
  const foldersEl = document.getElementById('bookmarkFolders');
  if (!section || !foldersEl) return;

  const allBookmarks = section._allBookmarks || [];
  if (q.length < 2) {
    // Show all groups
    const groups = section._groups || [];
    foldersEl.innerHTML = groups.map(g => renderBookmarkCard(g)).join('');
    return;
  }

  // Filter bookmarks matching query
  const filtered = allBookmarks.filter(bm =>
    (bm.title || '').toLowerCase().includes(q) ||
    (bm.url || '').toLowerCase().includes(q) ||
    (bm.folder || '').toLowerCase().includes(q)
  );

  if (filtered.length === 0) {
    foldersEl.innerHTML = '<div class="bookmark-empty">No bookmarks match your search.</div>';
    return;
  }

  const groups = groupBookmarksByFolder(filtered);
  foldersEl.innerHTML = groups.map(g => renderBookmarkCard(g)).join('');
});

// ---- Handle bookmark actions via event delegation ----
document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  // ---- Open bookmark (click on chip) ----
  if (action === 'open-bookmark') {
    // Don't trigger if user clicked a nested action button
    if (e.target.closest('.chip-actions')) return;

    const url = actionEl.dataset.tabUrl;
    if (!url) return;

    const existing = openTabs.find(t => t.url === url);
    if (existing) {
      await focusTab(url);
    } else {
      await chrome.tabs.create({ url, active: false });
      showToast('Opened bookmark');
    }
    return;
  }

  // ---- Delete bookmark ----
  if (action === 'delete-bookmark') {
    e.stopPropagation();
    const bmId = actionEl.dataset.bmId;
    if (!bmId) return;

    try {
      await chrome.bookmarks.remove(bmId);
    } catch (err) {
      showToast('Failed to delete bookmark');
      return;
    }

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If card is now empty, remove it
        const parentCard = chip.closest ? null : null; // chip already removed
        document.querySelectorAll('.bookmark-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="open-bookmark"]').length === 0) {
            c.style.transition = 'opacity 0.25s, transform 0.25s';
            c.style.opacity = '0';
            c.style.transform = 'scale(0.95)';
            setTimeout(() => c.remove(), 250);
          }
        });
      }, 200);
    }

    showToast('Bookmark deleted');
    // Update stored data
    const section = document.getElementById('bookmarksSection');
    if (section && section._allBookmarks) {
      section._allBookmarks = section._allBookmarks.filter(bm => bm.id !== bmId);
      section._groups = groupBookmarksByFolder(section._allBookmarks);
    }
    return;
  }

  // ---- Move bookmark — show folder picker dropdown ----
  if (action === 'move-bookmark') {
    e.stopPropagation();
    closeMoveDropdown(); // close any existing one

    const bmId = actionEl.dataset.bmId;
    const bmUrl = actionEl.dataset.bmUrl;
    const bmTitle = actionEl.dataset.bmTitle;
    if (!bmId) return;

    const section = document.getElementById('bookmarksSection');
    const folders = section?._folders || [];
    const suggested = suggestFolderName(bmUrl, bmTitle);

    const dropdown = document.createElement('div');
    dropdown.className = 'bm-move-dropdown';
    dropdown.id = 'bmMoveDropdown';
    dropdown.dataset.bmId = bmId;

    // Suggested folder at top
    let suggestedHtml = '';
    if (suggested) {
      const existingFolder = folders.find(f => f.title === suggested);
      if (existingFolder) {
        suggestedHtml = `<div class="bm-move-suggestion">
          <span class="bm-move-suggestion-label">Suggested</span>
          <button class="bm-move-option bm-move-suggested" data-action="move-to-folder" data-folder-id="${existingFolder.id}" data-bm-id="${bmId}">
            ${suggested}
          </button>
        </div>`;
      } else {
        suggestedHtml = `<div class="bm-move-suggestion">
          <span class="bm-move-suggestion-label">Suggested — create new folder</span>
          <button class="bm-move-option bm-move-suggested" data-action="move-to-new-folder" data-folder-name="${suggested}" data-bm-id="${bmId}">
            + ${suggested}
          </button>
        </div>`;
      }
    }

    const folderListHtml = folders
      .slice(0, 15)
      .map(f => `<button class="bm-move-option" data-action="move-to-folder" data-folder-id="${f.id}" data-bm-id="${bmId}" title="${f.path}">${f.title}</button>`)
      .join('');

    dropdown.innerHTML = `
      ${suggestedHtml}
      <div class="bm-move-create-row">
        <input type="text" class="bm-move-new-input" id="bmMoveNewInput" placeholder="New folder name..." autocomplete="off">
        <button class="bm-move-create-btn" data-action="move-to-new-folder-input" data-bm-id="${bmId}" title="Create & move">+</button>
      </div>
      <div class="bm-move-divider"></div>
      <div class="bm-move-list">${folderListHtml}</div>
    `;

    // Position near the button
    const rect = actionEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.max(8, rect.left - 100) + 'px';
    dropdown.style.zIndex = '200';

    document.body.appendChild(dropdown);

    // Focus the input
    setTimeout(() => document.getElementById('bmMoveNewInput')?.focus(), 50);

    // Enter key in the new folder input
    dropdown.querySelector('#bmMoveNewInput')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        dropdown.querySelector('[data-action="move-to-new-folder-input"]')?.click();
      }
      if (ev.key === 'Escape') {
        closeMoveDropdown();
      }
    });

    return;
  }

  // ---- Move to existing folder ----
  if (action === 'move-to-folder') {
    e.stopPropagation();
    const bmId = actionEl.dataset.bmId;
    const folderId = actionEl.dataset.folderId;
    if (!bmId || !folderId) return;

    try {
      await chrome.bookmarks.move(bmId, { parentId: folderId });
      showToast(`Moved to ${actionEl.textContent.trim()}`);
    } catch {
      showToast('Failed to move bookmark');
    }

    closeMoveDropdown();
    await renderBookmarksSection();
    return;
  }

  // ---- Move to new folder (from suggestion) ----
  if (action === 'move-to-new-folder') {
    e.stopPropagation();
    const bmId = actionEl.dataset.bmId;
    const folderName = actionEl.dataset.folderName;
    if (!bmId || !folderName) return;

    try {
      // Create folder under "Bookmarks Bar" (id "1") by default
      const newFolder = await chrome.bookmarks.create({ parentId: '1', title: folderName });
      await chrome.bookmarks.move(bmId, { parentId: newFolder.id });
      showToast(`Created "${folderName}" and moved bookmark`);
    } catch {
      showToast('Failed to create folder');
    }

    closeMoveDropdown();
    await renderBookmarksSection();
    return;
  }

  // ---- Move to new folder (from text input) ----
  if (action === 'move-to-new-folder-input') {
    e.stopPropagation();
    const bmId = actionEl.dataset.bmId;
    const input = document.getElementById('bmMoveNewInput');
    const folderName = input?.value.trim();
    if (!bmId || !folderName) return;

    try {
      const newFolder = await chrome.bookmarks.create({ parentId: '1', title: folderName });
      await chrome.bookmarks.move(bmId, { parentId: newFolder.id });
      showToast(`Created "${folderName}" and moved bookmark`);
    } catch {
      showToast('Failed to create folder');
    }

    closeMoveDropdown();
    await renderBookmarksSection();
    return;
  }
});

function closeMoveDropdown() {
  document.getElementById('bmMoveDropdown')?.remove();
}

// Close move dropdown when clicking outside
document.addEventListener('mousedown', (e) => {
  const dropdown = document.getElementById('bmMoveDropdown');
  if (dropdown && !dropdown.contains(e.target) && !e.target.closest('[data-action="move-bookmark"]')) {
    closeMoveDropdown();
  }
});


/* ----------------------------------------------------------------
   BROWSING HISTORY — fetch, analyze, and summarize
   ---------------------------------------------------------------- */

/**
 * fetchHistory(range)
 *
 * Fetches browsing history from Chrome for the given range.
 * range: 'today' | 'week' | 'month'
 */
async function fetchHistory(range = 'today') {
  const now = Date.now();
  const ranges = {
    today: now - 24 * 60 * 60 * 1000,
    week:  now - 7 * 24 * 60 * 60 * 1000,
    month: now - 30 * 24 * 60 * 60 * 1000,
  };
  const startTime = ranges[range] || ranges.today;

  try {
    const items = await chrome.history.search({
      text: '',
      startTime,
      maxResults: 5000,
    });
    // Filter out internal pages
    return items.filter(item => {
      const url = item.url || '';
      return !url.startsWith('chrome://') &&
             !url.startsWith('chrome-extension://') &&
             !url.startsWith('about:') &&
             !url.startsWith('edge://') &&
             !url.startsWith('brave://');
    });
  } catch {
    return [];
  }
}

/**
 * analyzeHistory(items)
 *
 * Groups history by domain, computes stats, identifies top sites and patterns.
 */
function analyzeHistory(items) {
  const byDomain = {};
  const byHour = new Array(24).fill(0);
  let totalVisits = 0;

  for (const item of items) {
    let hostname = '';
    try { hostname = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }

    if (!byDomain[hostname]) {
      byDomain[hostname] = { domain: hostname, visits: 0, pages: [], uniqueUrls: new Set() };
    }
    const group = byDomain[hostname];
    group.visits += item.visitCount || 1;
    totalVisits += item.visitCount || 1;
    group.uniqueUrls.add(item.url);
    group.pages.push({
      title: item.title || item.url,
      url: item.url,
      visitCount: item.visitCount || 1,
      lastVisit: item.lastVisitTime,
    });

    if (item.lastVisitTime) {
      const hour = new Date(item.lastVisitTime).getHours();
      byHour[hour] += item.visitCount || 1;
    }
  }

  // Sort domains by visit count
  const topDomains = Object.values(byDomain)
    .map(d => ({ ...d, uniqueCount: d.uniqueUrls.size }))
    .sort((a, b) => b.visits - a.visits);

  // Peak hour
  const peakHour = byHour.indexOf(Math.max(...byHour));

  return {
    totalItems: items.length,
    totalVisits,
    uniqueDomains: topDomains.length,
    topDomains,
    byHour,
    peakHour,
  };
}

/**
 * renderHistoryStats(analysis)
 */
function renderHistoryStats(analysis) {
  const peakLabel = analysis.peakHour < 12
    ? `${analysis.peakHour || 12}${analysis.peakHour === 0 ? ' AM' : ' AM'}`
    : `${analysis.peakHour === 12 ? 12 : analysis.peakHour - 12} PM`;

  return `
    <div class="history-stat-cards">
      <div class="history-stat-card">
        <div class="history-stat-num">${analysis.totalItems}</div>
        <div class="history-stat-label">pages visited</div>
      </div>
      <div class="history-stat-card">
        <div class="history-stat-num">${analysis.uniqueDomains}</div>
        <div class="history-stat-label">different sites</div>
      </div>
      <div class="history-stat-card">
        <div class="history-stat-num">${analysis.totalVisits}</div>
        <div class="history-stat-label">total visits</div>
      </div>
      <div class="history-stat-card">
        <div class="history-stat-num">${peakLabel}</div>
        <div class="history-stat-label">peak hour</div>
      </div>
    </div>`;
}

/**
 * renderHistoryTimeline(analysis)
 *
 * Renders top domains as cards with their most visited pages.
 */
function renderHistoryTimeline(analysis) {
  const top = analysis.topDomains.slice(0, 12);

  return top.map(group => {
    // Sort pages by visit count, deduplicate
    const seen = new Set();
    const uniquePages = [];
    for (const p of group.pages.sort((a, b) => b.visitCount - a.visitCount)) {
      if (!seen.has(p.url)) { seen.add(p.url); uniquePages.push(p); }
    }

    const visiblePages = uniquePages.slice(0, 5);
    const extraCount = uniquePages.length - visiblePages.length;

    const chips = visiblePages.map(p => {
      const label = stripTitleNoise(cleanTitle(p.title, group.domain));
      const safeUrl = (p.url || '').replace(/"/g, '&quot;');
      let domain = '';
      try { domain = new URL(p.url).hostname; } catch {}
      const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
      const visitBadge = p.visitCount > 1 ? ` <span class="history-visit-count">${p.visitCount}x</span>` : '';

      return `<div class="page-chip clickable" data-action="open-history-link" data-tab-url="${safeUrl}" title="${label}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
        <span class="chip-text">${label}${visitBadge}</span>
      </div>`;
    }).join('');

    const overflowHtml = extraCount > 0 ? `<div class="page-chip page-chip-overflow">${extraCount} more page${extraCount > 1 ? 's' : ''}</div>` : '';

    // Activity bar (visual representation of visit intensity)
    const maxVisits = analysis.topDomains[0]?.visits || 1;
    const barWidth = Math.max(8, Math.round((group.visits / maxVisits) * 100));

    return `
      <div class="mission-card history-card has-neutral-bar">
        <div class="status-bar"></div>
        <div class="mission-content">
          <div class="mission-top">
            <span class="mission-name">${friendlyDomain(group.domain)}</span>
            <span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
              ${group.visits} visit${group.visits !== 1 ? 's' : ''} &middot; ${group.uniqueCount} page${group.uniqueCount !== 1 ? 's' : ''}
            </span>
          </div>
          <div class="history-bar-row">
            <div class="history-bar" style="width:${barWidth}%"></div>
          </div>
          <div class="mission-pages">${chips}${overflowHtml}</div>
        </div>
      </div>`;
  }).join('');
}

/**
 * groupIntoSessions(items, gapMinutes)
 *
 * Groups history items into browsing sessions. A new session starts
 * when there's a gap of >= gapMinutes between consecutive visits.
 */
function groupIntoSessions(items, gapMinutes = 30) {
  if (items.length === 0) return [];

  // Sort by lastVisitTime descending (most recent first)
  const sorted = [...items]
    .filter(i => i.lastVisitTime)
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime);

  if (sorted.length === 0) return [];

  const gapMs = gapMinutes * 60 * 1000;
  const sessions = [];
  let currentSession = { items: [sorted[0]], start: sorted[0].lastVisitTime, end: sorted[0].lastVisitTime };

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const gap = currentSession.items[currentSession.items.length - 1].lastVisitTime - item.lastVisitTime;

    if (gap > gapMs) {
      // Finalize current session
      currentSession.start = currentSession.items[currentSession.items.length - 1].lastVisitTime;
      sessions.push(currentSession);
      currentSession = { items: [item], start: item.lastVisitTime, end: item.lastVisitTime };
    } else {
      currentSession.items.push(item);
    }
  }
  // Push last session
  currentSession.start = currentSession.items[currentSession.items.length - 1].lastVisitTime;
  sessions.push(currentSession);

  return sessions;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remainder = mins % 60;
  return remainder > 0 ? `${hrs}h ${remainder}m` : `${hrs}h`;
}

function sessionDuration(session) {
  return formatDuration(session.end - session.start);
}

/**
 * renderSessionCard(session)
 *
 * Renders a single browsing session as a timeline card.
 */
function renderSessionCard(session) {
  const timeRange = `${formatTime(session.start)} — ${formatTime(session.end)}`;
  const duration = sessionDuration(session);

  // Group session items by domain
  const domainMap = {};
  for (const item of session.items) {
    let hostname = '';
    try { hostname = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!domainMap[hostname]) domainMap[hostname] = [];
    domainMap[hostname].push(item);
  }

  const domainGroups = Object.entries(domainMap)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, pages]) => {
      const seen = new Set();
      const unique = [];
      for (const p of pages) {
        if (!seen.has(p.url)) { seen.add(p.url); unique.push(p); }
      }
      return { domain, pages: unique };
    });

  const totalPages = domainGroups.reduce((s, g) => s + g.pages.length, 0);

  const domainChips = domainGroups.slice(0, 6).map(g => {
    const chips = g.pages.slice(0, 3).map(p => {
      const label = stripTitleNoise(cleanTitle(p.title || '', g.domain));
      const safeUrl = (p.url || '').replace(/"/g, '&quot;');
      let dom = '';
      try { dom = new URL(p.url).hostname; } catch {}
      const faviconUrl = dom ? `https://www.google.com/s2/favicons?domain=${dom}&sz=16` : '';
      return `<div class="page-chip clickable" data-action="open-history-link" data-tab-url="${safeUrl}" title="${label}">
        ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
        <span class="chip-text">${label}</span>
      </div>`;
    }).join('');

    const moreCount = g.pages.length - 3;
    const moreHtml = moreCount > 0 ? `<div class="page-chip page-chip-overflow">+${moreCount} more</div>` : '';

    return `<div class="session-domain-group">
      <div class="session-domain-name">${friendlyDomain(g.domain)} <span class="session-domain-count">${g.pages.length}</span></div>
      <div class="mission-pages">${chips}${moreHtml}</div>
    </div>`;
  }).join('');

  const moreDomainsCount = domainGroups.length - 6;
  const moreDomains = moreDomainsCount > 0 ? `<div class="session-more-domains">+${moreDomainsCount} more site${moreDomainsCount > 1 ? 's' : ''}</div>` : '';

  return `
  <div class="session-card">
    <div class="session-dot-line">
      <div class="session-dot"></div>
      <div class="session-line-v"></div>
    </div>
    <div class="session-body">
      <div class="session-header">
        <span class="session-time">${timeRange}</span>
        <span class="session-duration">${duration}</span>
        <span class="session-page-count">${totalPages} page${totalPages !== 1 ? 's' : ''}</span>
      </div>
      <div class="session-domains">${domainChips}${moreDomains}</div>
    </div>
  </div>`;
}

/**
 * renderAfbGap(gapMs, startTime, endTime)
 *
 * Renders an "Away from browser" gap between sessions.
 */
function renderAfbGap(gapMs, startTime, endTime) {
  const duration = formatDuration(gapMs);
  return `
  <div class="session-card afb-card">
    <div class="session-dot-line">
      <div class="session-dot afb-dot"></div>
      <div class="session-line-v afb-line"></div>
    </div>
    <div class="session-body afb-body">
      <div class="afb-header">
        <span class="afb-time">${formatTime(endTime)} — ${formatTime(startTime)}</span>
        <span class="afb-label">Away from browser</span>
        <span class="afb-duration">${duration}</span>
      </div>
    </div>
  </div>`;
}

/**
 * renderSessionView(items)
 *
 * Renders history grouped by browsing sessions as a vertical timeline,
 * with "Away from browser" gaps shown between sessions.
 */
function renderSessionView(items) {
  const sessions = groupIntoSessions(items);
  if (sessions.length === 0) return '<div class="history-empty">No sessions found.</div>';

  const MIN_GAP_TO_SHOW = 5 * 60 * 1000; // Only show gaps > 5 minutes

  // Group sessions by date for per-day stats
  const sessionsByDate = {};
  for (const s of sessions) {
    const dateKey = formatDate(s.end);
    if (!sessionsByDate[dateKey]) sessionsByDate[dateKey] = [];
    sessionsByDate[dateKey].push(s);
  }

  // Compute per-day summary
  function dayStats(daySessions) {
    const browsingMs = daySessions.reduce((sum, s) => sum + (s.end - s.start), 0);
    const spanMs = daySessions[0].end - daySessions[daySessions.length - 1].start;
    const awayMs = Math.max(0, spanMs - browsingMs);
    return { browsingMs, awayMs, count: daySessions.length };
  }

  const parts = [];
  let lastDate = '';

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    // Date header with daily stats
    const dateLabel = formatDate(session.end);
    if (dateLabel !== lastDate) {
      lastDate = dateLabel;
      const stats = dayStats(sessionsByDate[dateLabel]);
      parts.push(`<div class="session-date-header">
        <span class="session-date-label">${dateLabel}</span>
        <span class="session-day-stats">
          <span class="session-day-stat browsing">${formatDuration(stats.browsingMs)} browsing</span>
          <span class="session-day-stat away">${formatDuration(stats.awayMs)} away</span>
          <span class="session-day-stat count">${stats.count} session${stats.count !== 1 ? 's' : ''}</span>
        </span>
      </div>`);
    }

    // Render session
    parts.push(renderSessionCard(session));

    // AFB gap between this session and the next
    if (i < sessions.length - 1) {
      const nextSession = sessions[i + 1];
      const gapMs = session.start - nextSession.end;

      if (gapMs > MIN_GAP_TO_SHOW) {
        parts.push(renderAfbGap(gapMs, session.start, nextSession.end));
      }
    }
  }

  // Gap from last session to start of day
  const lastSession = sessions[sessions.length - 1];
  const dayStart = new Date(lastSession.start);
  dayStart.setHours(0, 0, 0, 0);
  const gapToStart = lastSession.start - dayStart.getTime();
  if (gapToStart > MIN_GAP_TO_SHOW) {
    parts.push(renderAfbGap(gapToStart, lastSession.start, dayStart.getTime()));
  }

  // Overall summary
  const totalBrowsingMs = sessions.reduce((s, sess) => s + (sess.end - sess.start), 0);
  const firstSession = sessions[0];
  const totalSpanMs = firstSession.end - lastSession.start;
  const totalAwayMs = Math.max(0, totalSpanMs - totalBrowsingMs);

  parts.push(`
  <div class="session-summary">
    <div class="session-summary-item">
      <span class="session-summary-dot active"></span>
      Browsing: <strong>${formatDuration(totalBrowsingMs)}</strong>
    </div>
    <div class="session-summary-item">
      <span class="session-summary-dot away"></span>
      Away: <strong>${formatDuration(totalAwayMs > 0 ? totalAwayMs : 0)}</strong>
    </div>
    <div class="session-summary-item">
      ${sessions.length} session${sessions.length !== 1 ? 's' : ''} over ${formatDuration(totalSpanMs)}
    </div>
  </div>`);

  return parts.join('');
}

let currentHistoryRange = 'today';
let currentHistoryView = 'domain';
let currentHistoryAnalysis = null;
let currentHistoryItems = null;

async function renderHistorySection(range = 'today', view = currentHistoryView) {
  const section = document.getElementById('historySection');
  const countEl = document.getElementById('historyCount');
  const statsEl = document.getElementById('historyStats');
  const timelineEl = document.getElementById('historyTimeline');
  if (!section) return;

  const rangeChanged = range !== currentHistoryRange;
  currentHistoryRange = range;
  currentHistoryView = view;

  // Only re-fetch if range changed
  if (!currentHistoryItems || rangeChanged) {
    currentHistoryItems = await fetchHistory(range);
  }

  const items = currentHistoryItems;
  if (items.length === 0) {
    if (countEl) countEl.textContent = '';
    if (statsEl) statsEl.innerHTML = '';
    if (timelineEl) timelineEl.innerHTML = '<div class="history-empty">No browsing history for this period.</div>';
    return;
  }

  const analysis = analyzeHistory(items);
  currentHistoryAnalysis = analysis;

  const rangeLabels = { today: 'today', week: 'this week', month: 'this month' };
  const sessions = groupIntoSessions(items);
  const sessionLabel = sessions.length > 0 ? ` · ${sessions.length} session${sessions.length !== 1 ? 's' : ''}` : '';
  if (countEl) countEl.textContent = `${analysis.totalItems} pages ${rangeLabels[range]}${sessionLabel}`;
  if (statsEl) statsEl.innerHTML = renderHistoryStats(analysis);

  if (view === 'session') {
    if (timelineEl) {
      timelineEl.className = 'history-timeline session-view';
      timelineEl.innerHTML = renderSessionView(items);
    }
  } else {
    if (timelineEl) {
      timelineEl.className = 'history-timeline';
      timelineEl.innerHTML = renderHistoryTimeline(analysis);
    }
  }
}

// Range tab clicks
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.history-range-tab');
  if (!tab) return;
  const range = tab.dataset.range;
  if (!range) return;

  document.querySelectorAll('.history-range-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentHistoryItems = null; // force re-fetch
  renderHistorySection(range, currentHistoryView);
});

// View toggle clicks (by site / by session)
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.history-view-tab');
  if (!tab) return;
  const view = tab.dataset.view;
  if (!view) return;

  document.querySelectorAll('.history-view-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  renderHistorySection(currentHistoryRange, view);
});

// Open history link
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action="open-history-link"]');
  if (!el) return;
  const url = el.dataset.tabUrl;
  if (!url) return;

  const existing = openTabs.find(t => t.url === url);
  if (existing) {
    await focusTab(url);
  } else {
    await chrome.tabs.create({ url, active: false });
    showToast('Opened page');
  }
});

// AI summarize history
document.getElementById('historyAiBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('historyAiBtn');
  const responseEl = document.getElementById('historyAiResponse');
  if (!btn || !responseEl || !currentHistoryAnalysis) return;

  const apiKey = await getBookmarkApiKey();
  if (!apiKey) {
    responseEl.style.display = '';
    responseEl.innerHTML = '<div class="bookmark-ai-error">Set up your API key in the Bookmarks section first.</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  responseEl.style.display = '';
  responseEl.innerHTML = '<div class="insight-loading"><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div></div>';

  // Build context from analysis
  const a = currentHistoryAnalysis;
  const rangeLabels = { today: 'today', week: 'this week', month: 'this month' };
  let ctx = `Browsing history summary for ${rangeLabels[currentHistoryRange]}:\n\n`;
  ctx += `Total: ${a.totalItems} pages, ${a.totalVisits} visits, ${a.uniqueDomains} sites\n\n`;
  ctx += `Top sites:\n`;
  for (const d of a.topDomains.slice(0, 20)) {
    ctx += `\n[${friendlyDomain(d.domain)}] — ${d.visits} visits, ${d.uniqueCount} pages\n`;
    const seen = new Set();
    for (const p of d.pages.sort((x, y) => y.visitCount - x.visitCount).slice(0, 8)) {
      if (!seen.has(p.url)) {
        seen.add(p.url);
        ctx += `  - ${stripTitleNoise(p.title)} (${p.visitCount}x) | ${p.url}\n`;
      }
    }
  }

  // Hour distribution
  ctx += `\nActivity by hour:\n`;
  for (let h = 0; h < 24; h++) {
    if (a.byHour[h] > 0) ctx += `  ${h}:00 — ${a.byHour[h]} visits\n`;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1536,
        system: `You are an insightful personal analyst. Given a user's browsing history data, provide a concise, useful summary:

## Patterns
What topics dominated? Any focus sessions or context-switching? Were they productive, researching, or browsing casually?

## Key activities
The main things they worked on or explored, in bullet points. Be specific about the content, not just the sites.

## Time insights
When were they most active? Any notable patterns (late night coding, morning news, etc)?

## Observations
1-2 interesting or surprising observations (e.g. "You visited Stack Overflow 23 times — deep debugging session?" or "Heavy GitHub + Linear usage suggests an active sprint").

Be concise, insightful, and slightly witty. Match the user's language.`,
        messages: [{ role: 'user', content: ctx }],
      }),
    });

    if (!resp.ok) throw new Error(resp.status === 401 ? 'Invalid API key' : `API error: ${resp.status}`);
    const data = await resp.json();
    const text = data.content?.[0]?.text || 'No response.';
    responseEl.innerHTML = `<div class="insight-content">${renderInsightHtml(text)}</div>`;
  } catch (err) {
    responseEl.innerHTML = `<div class="bookmark-ai-error">${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg> Summarize with AI`;
  }
});


/* ----------------------------------------------------------------
   DAILY INSIGHTS — AI-generated daily report
   ---------------------------------------------------------------- */

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-04-16"
}

async function getCachedInsight() {
  try {
    const result = await chrome.storage.local.get('dailyInsight');
    return result.dailyInsight || null;
  } catch { return null; }
}

async function saveCachedInsight(data) {
  try { await chrome.storage.local.set({ dailyInsight: data }); } catch {}
}

/**
 * buildInsightsContext()
 *
 * Builds a rich context string from open tabs + bookmarks for the AI
 * to generate a daily summary.
 */
function buildInsightsContext() {
  const realTabs = getRealTabs();

  // Open tabs grouped by domain
  const tabsByDomain = {};
  for (const t of realTabs) {
    let domain;
    try { domain = new URL(t.url).hostname.replace(/^www\./, ''); } catch { domain = 'other'; }
    if (!tabsByDomain[domain]) tabsByDomain[domain] = [];
    tabsByDomain[domain].push({ title: t.title || t.url, url: t.url });
  }

  let ctx = `== OPEN TABS (${realTabs.length} total) ==\n\n`;
  for (const [domain, tabs] of Object.entries(tabsByDomain).sort((a, b) => b[1].length - a[1].length)) {
    ctx += `[${friendlyDomain(domain)}] (${tabs.length})\n`;
    for (const t of tabs) {
      ctx += `  - ${stripTitleNoise(t.title)} | ${t.url}\n`;
    }
    ctx += '\n';
  }

  // Recent bookmarks (last 30 days)
  const section = document.getElementById('bookmarksSection');
  const allBookmarks = section?._allBookmarks || [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentBookmarks = allBookmarks.filter(bm => bm.dateAdded > thirtyDaysAgo);

  if (recentBookmarks.length > 0) {
    ctx += `\n== RECENT BOOKMARKS (last 30 days, ${recentBookmarks.length} items) ==\n\n`;
    for (const bm of recentBookmarks.slice(0, 50)) {
      ctx += `  - [${bm.folder}] ${bm.title} | ${bm.url}\n`;
    }
    if (recentBookmarks.length > 50) {
      ctx += `  ... and ${recentBookmarks.length - 50} more\n`;
    }
  }

  // Saved for later
  ctx += `\n== CONTEXT ==\n`;
  ctx += `Date: ${getDateDisplay()}\n`;
  ctx += `Total bookmarks: ${allBookmarks.length}\n`;

  return ctx;
}

async function generateDailyInsight(forceRefresh = false) {
  const apiKey = await getBookmarkApiKey();
  if (!apiKey) {
    return { error: 'no-key' };
  }

  // Check cache
  if (!forceRefresh) {
    const cached = await getCachedInsight();
    if (cached && cached.date === getTodayKey()) {
      return cached;
    }
  }

  const context = buildInsightsContext();

  const systemPrompt = `You are a personal productivity assistant embedded in a browser new tab page. Based on the user's open tabs and recent bookmarks, write a concise daily report.

Structure your response EXACTLY like this:

## What you're focused on
A 2-3 sentence summary of what the user seems to be working on or interested in today, based on their open tabs.

## Active threads
List the main topics/projects as bullet points, each with a brief note. Group related tabs together.

## All links
List every open tab URL, grouped by topic. Format each as:
- [Page Title](url)

## Suggestions
1-2 optional, brief suggestions (e.g. "You have 5 GitHub PRs open — might be review day" or "Lots of research tabs — consider bookmarking before closing").

Keep it concise and useful. Match the user's language — if tab titles are mostly Chinese, write in Chinese; if English, write in English. Don't be overly chatty.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: context }],
    }),
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new Error('Invalid API key');
    throw new Error(`API error: ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || 'No response.';

  const result = { date: getTodayKey(), text, generatedAt: new Date().toISOString() };
  await saveCachedInsight(result);
  return result;
}

/**
 * renderInsightHtml(text)
 *
 * Converts the markdown-ish AI response into styled HTML.
 * Handles ## headings, bullet points, [links](url), **bold**.
 */
function renderInsightHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Links: [title](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="insight-link">$1</a>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // ## Headings
    .replace(/^## (.+)$/gm, '<h3 class="insight-heading">$1</h3>')
    // Bullet points
    .replace(/^[-*] (.+)$/gm, '<div class="insight-bullet">$1</div>')
    // Numbered lists
    .replace(/^\d+\.\s+(.+)$/gm, '<div class="insight-bullet insight-numbered">$1</div>')
    // Paragraphs
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

async function initInsightsSection() {
  const section = document.getElementById('insightsSection');
  const dateEl = document.getElementById('insightsDate');
  const body = document.getElementById('insightsBody');
  const generateBtn = document.getElementById('insightsGenerateBtn');
  const refreshBtn = document.getElementById('insightsRefreshBtn');
  if (!section) return;

  const apiKey = await getBookmarkApiKey();

  // Check for cached report
  const cached = await getCachedInsight();
  if (cached && cached.date === getTodayKey() && body) {
    body.innerHTML = `<div class="insight-content">${renderInsightHtml(cached.text)}</div>
      <div class="insight-meta">Generated ${new Date(cached.generatedAt).toLocaleTimeString()}</div>`;
    if (generateBtn) generateBtn.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = '';
  } else if (!apiKey) {
    if (body) body.innerHTML = '<div class="insight-empty">Set up your API key in the Bookmarks section above, then come back to generate your daily report.</div>';
  } else {
    if (body) body.innerHTML = '<div class="insight-empty">Click below to generate today\'s report based on your open tabs and recent bookmarks.</div>';
  }
}

// Generate button
document.getElementById('insightsGenerateBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('insightsGenerateBtn');
  const body = document.getElementById('insightsBody');
  const refreshBtn = document.getElementById('insightsRefreshBtn');
  if (!btn || !body) return;

  btn.disabled = true;
  btn.textContent = 'Generating report...';
  body.innerHTML = '<div class="insight-loading"><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div></div>';

  try {
    const result = await generateDailyInsight(false);
    if (result.error === 'no-key') {
      body.innerHTML = '<div class="insight-empty">Set up your API key in the Bookmarks section above first.</div>';
      return;
    }
    body.innerHTML = `<div class="insight-content">${renderInsightHtml(result.text)}</div>
      <div class="insight-meta">Generated ${new Date(result.generatedAt).toLocaleTimeString()}</div>`;
    btn.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = '';
  } catch (err) {
    body.innerHTML = `<div class="bookmark-ai-error">${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg> Generate today's report`;
  }
});

// Refresh button (regenerate)
document.getElementById('insightsRefreshBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('insightsRefreshBtn');
  const body = document.getElementById('insightsBody');
  if (!btn || !body) return;

  btn.disabled = true;
  body.innerHTML = '<div class="insight-loading"><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div><div class="insight-loading-dot"></div></div>';

  try {
    const result = await generateDailyInsight(true);
    body.innerHTML = `<div class="insight-content">${renderInsightHtml(result.text)}</div>
      <div class="insight-meta">Generated ${new Date(result.generatedAt).toLocaleTimeString()}</div>`;
  } catch (err) {
    body.innerHTML = `<div class="bookmark-ai-error">${err.message}</div>`;
  } finally {
    btn.disabled = false;
  }
});


/* ----------------------------------------------------------------
   AI CHAT — Claude-powered chat with tab + history context
   ---------------------------------------------------------------- */

let chatMessages = []; // { role: 'user'|'assistant', content: string }

function buildChatContext() {
  // Open tabs
  const grouped = {};
  for (const t of openTabs) {
    if (t.isTabOut) continue;
    let domain;
    try { domain = new URL(t.url).hostname; } catch { domain = 'other'; }
    if (!grouped[domain]) grouped[domain] = [];
    grouped[domain].push(t.title || t.url);
  }

  let ctx = `The user has ${openTabs.filter(t => !t.isTabOut).length} open browser tabs:\n\n`;
  for (const [domain, titles] of Object.entries(grouped)) {
    ctx += `[${domain}] (${titles.length} tab${titles.length > 1 ? 's' : ''})\n`;
    for (const title of titles) ctx += `  - ${title}\n`;
    ctx += '\n';
  }

  // Recent history summary
  if (currentHistoryAnalysis) {
    const a = currentHistoryAnalysis;
    ctx += `\nRecent browsing (${currentHistoryRange}): ${a.totalItems} pages across ${a.uniqueDomains} sites.\n`;
    ctx += `Top sites: ${a.topDomains.slice(0, 5).map(d => `${friendlyDomain(d.domain)} (${d.visits})`).join(', ')}\n`;
  }

  return ctx;
}

async function callChat(userMessage) {
  const apiKey = await getBookmarkApiKey();
  if (!apiKey) throw new Error('No API key');

  chatMessages.push({ role: 'user', content: userMessage });

  const systemPrompt = `You are Tidy Tabby AI, a helpful assistant embedded in a browser new tab page. You can see the user's open tabs and recent browsing history. Help them organize, summarize, find, or reason about what they're working on.

${buildChatContext()}

Be concise and helpful. Use short, conversational responses. Match the user's language.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: chatMessages,
    }),
  });

  if (!resp.ok) {
    chatMessages.pop();
    throw new Error(resp.status === 401 ? 'Invalid API key' : `API error: ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || 'Sorry, I got an empty response.';
  chatMessages.push({ role: 'assistant', content: text });
  return text;
}

function appendChatMsg(role, text) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg-${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function initChat() {
  const apiKey = await getBookmarkApiKey();
  const setup = document.getElementById('chatSetup');
  const area = document.getElementById('chatArea');
  if (apiKey) {
    if (setup) setup.style.display = 'none';
    if (area) area.style.display = '';
  } else {
    if (setup) setup.style.display = '';
    if (area) area.style.display = 'none';
  }
}

// Save API key from chat setup
document.getElementById('chatKeySave')?.addEventListener('click', async () => {
  const input = document.getElementById('chatKeyInput');
  const key = input?.value.trim();
  if (!key) return;
  await saveBookmarkApiKey(key);
  await initChat();
  await initBookmarkAi(); // sync the bookmark AI key state too
  document.getElementById('chatInput')?.focus();
});

document.getElementById('chatKeyInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('chatKeySave')?.click(); }
});

// Suggestion buttons
document.querySelectorAll('.chat-suggestion').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById('chatInput');
    if (input) input.value = btn.dataset.prompt;
    document.getElementById('chatInputForm')?.requestSubmit();
  });
});

// Send message
document.getElementById('chatInputForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');
  const text = input?.value.trim();
  if (!text || !input) return;

  input.value = '';
  input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  // Hide suggestions after first message
  const suggestions = document.getElementById('chatSuggestions');
  if (suggestions) suggestions.style.display = 'none';

  appendChatMsg('user', text);
  const thinking = appendChatMsg('thinking', 'Thinking...');

  try {
    const reply = await callChat(text);
    thinking?.remove();
    appendChatMsg('assistant', reply);
  } catch (err) {
    thinking?.remove();
    appendChatMsg('error', `Error: ${err.message}`);
    if (err.message === 'Invalid API key') {
      await saveBookmarkApiKey('');
      await initChat();
    }
  } finally {
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
});


/* ----------------------------------------------------------------
   TERMINAL — xterm.js + Chrome Native Messaging
   ---------------------------------------------------------------- */

let term = null;
let termPort = null;
let termInitialized = false;

function initTerminal() {
  if (termInitialized) return;
  termInitialized = true;

  const container = document.getElementById('terminalContainer');
  if (!container || typeof Terminal === 'undefined') return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: '#1a1613',
      foreground: '#f8f5f0',
      cursor: '#c8713a',
      selectionBackground: 'rgba(200, 113, 58, 0.3)',
      black: '#1a1613',
      red: '#b35a5a',
      green: '#5a7a62',
      yellow: '#c8713a',
      blue: '#5a6b7a',
      magenta: '#9a6b8a',
      cyan: '#5a8a8a',
      white: '#e8e2da',
      brightBlack: '#9a918a',
      brightRed: '#d47a7a',
      brightGreen: '#7a9a82',
      brightYellow: '#e8a070',
      brightBlue: '#7a8b9a',
      brightMagenta: '#ba8baa',
      brightCyan: '#7aaaaa',
      brightWhite: '#f8f5f0',
    },
  });

  if (typeof FitAddon !== 'undefined') {
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
    const observer = new MutationObserver(() => {
      const panel = document.getElementById('explorePanelTerminal');
      if (panel && panel.style.display !== 'none') {
        setTimeout(() => fitAddon.fit(), 50);
      }
    });
    const panel = document.getElementById('explorePanelTerminal');
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['style'] });
  } else {
    term.open(container);
  }

  term.writeln('\x1b[1;33mTidy Tabby — Claude Code\x1b[0m');
  term.writeln('Click Connect to start. Launches Claude Code if installed.');
  term.writeln('');

  // Send keystrokes to native host via background
  term.onData(data => {
    if (termPort) {
      termPort.postMessage({ type: 'input', data });
    }
  });
}

function connectTerminal() {
  const statusEl = document.getElementById('terminalStatus');
  const hintEl = document.getElementById('terminalHint');

  if (termPort) {
    termPort.disconnect();
    termPort = null;
  }

  if (statusEl) statusEl.innerHTML = '<span class="terminal-status-dot connecting"></span> Connecting...';

  termPort = chrome.runtime.connect({ name: 'terminal' });

  termPort.onMessage.addListener((msg) => {
    if (msg.type === 'connected') {
      if (statusEl) statusEl.innerHTML = '<span class="terminal-status-dot connected"></span> Connected';
      if (hintEl) hintEl.style.display = 'none';
      if (term) { term.clear(); term.focus(); }
    } else if (msg.type === 'output') {
      if (term) term.write(msg.data);
    } else if (msg.type === 'disconnected' || msg.type === 'error') {
      if (statusEl) statusEl.innerHTML = '<span class="terminal-status-dot disconnected"></span> Disconnected';
      if (hintEl) {
        hintEl.style.display = '';
        if (msg.data) hintEl.innerHTML = `<span style="color:var(--status-abandoned)">${msg.data}</span><br>Run: <code>./install-terminal.sh</code> to set up native messaging.`;
      }
      if (term) term.writeln('\r\n\x1b[90m[' + (msg.data || 'Disconnected') + ']\x1b[0m');
      termPort = null;
    }
  });

  termPort.onDisconnect.addListener(() => {
    if (statusEl) statusEl.innerHTML = '<span class="terminal-status-dot disconnected"></span> Disconnected';
    termPort = null;
  });
}

document.getElementById('terminalConnectBtn')?.addEventListener('click', () => {
  if (!termInitialized) initTerminal();
  connectTerminal();
});


/* ----------------------------------------------------------------
   EXPLORE TABS — switch between sections
   ---------------------------------------------------------------- */

const explorePanels = {
  tabs: 'explorePanelTabs',
  activity: 'explorePanelActivity',
  bookmarks: 'explorePanelBookmarks',
  insights: 'explorePanelInsights',
  chat: 'explorePanelChat',
  terminal: 'explorePanelTerminal',
};

function switchExploreTab(tabName) {
  document.querySelectorAll('.explore-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.explore === tabName);
  });
  for (const [key, id] of Object.entries(explorePanels)) {
    const panel = document.getElementById(id);
    if (panel) panel.style.display = key === tabName ? '' : 'none';
  }
  // Lazy-init terminal on first visit
  if (tabName === 'terminal' && !termInitialized) {
    initTerminal();
  }
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.explore-tab');
  if (!tab) return;
  const name = tab.dataset.explore;
  if (name) switchExploreTab(name);
});

function updateExploreCounts() {
  const tabsCount = document.getElementById('exploreTabsCount');
  const activityCount = document.getElementById('exploreActivityCount');
  const bookmarkCount = document.getElementById('exploreBookmarkCount');
  const section = document.getElementById('bookmarksSection');

  if (tabsCount) {
    const realCount = getRealTabs().length;
    tabsCount.textContent = realCount;
  }
  if (activityCount && currentHistoryAnalysis) {
    activityCount.textContent = currentHistoryAnalysis.totalItems;
  }
  if (bookmarkCount && section && section._allBookmarks) {
    bookmarkCount.textContent = section._allBookmarks.length;
  }
}


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
// Init privacy mode first to avoid content flash, then render
initPrivacyMode().then(async () => {
  await renderDashboard();
  await renderBookmarksSection();
  initBookmarkAi();
  await renderHistorySection('today');
  updateExploreCounts();
  initInsightsSection();
  initChat();
});
