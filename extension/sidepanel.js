'use strict';

/* ----------------------------------------------------------------
   SIDE PANEL — lightweight tab list + AI chat
   ---------------------------------------------------------------- */

// ---- Tab switching ----

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.sp-tab');
  if (!tab) return;
  const name = tab.dataset.spTab;
  document.querySelectorAll('.sp-tab').forEach(t => t.classList.toggle('active', t.dataset.spTab === name));
  document.getElementById('spPanelTabs').style.display = name === 'tabs' ? '' : 'none';
  document.getElementById('spPanelChat').style.display = name === 'chat' ? '' : 'none';
  if (name === 'chat') document.getElementById('spChatInput')?.focus();
});

// ---- Fetch and render tabs ----

async function renderTabList(filter = '') {
  const tabs = await chrome.tabs.query({});
  const list = document.getElementById('spTabList');
  if (!list) return;

  const q = filter.toLowerCase();

  const realTabs = tabs.filter(t => {
    const url = t.url || '';
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') &&
           !url.startsWith('about:') && !url.startsWith('edge://');
  });

  const filtered = q
    ? realTabs.filter(t => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))
    : realTabs;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="sp-empty">No tabs match.</div>';
    return;
  }

  // Group by domain
  const groups = {};
  for (const t of filtered) {
    let host = '';
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch { host = 'other'; }
    if (!groups[host]) groups[host] = [];
    groups[host].push(t);
  }

  list.innerHTML = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, tabs]) => {
      const items = tabs.map(t => {
        const favicon = t.favIconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
        const title = t.title || t.url;
        return `<div class="sp-tab-item" data-tab-id="${t.id}" data-window-id="${t.windowId}">
          <img class="sp-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">
          <span class="sp-tab-title">${title}</span>
          <button class="sp-tab-close" data-close-id="${t.id}" title="Close">&times;</button>
        </div>`;
      }).join('');
      return `<div class="sp-domain-group">
        <div class="sp-domain-name">${domain} <span class="sp-domain-count">${tabs.length}</span></div>
        ${items}
      </div>`;
    }).join('');
}

// Click to focus tab
document.addEventListener('click', async (e) => {
  const item = e.target.closest('.sp-tab-item');
  if (!item || e.target.closest('.sp-tab-close')) return;
  const tabId = parseInt(item.dataset.tabId);
  const windowId = parseInt(item.dataset.windowId);
  if (!isNaN(tabId)) await chrome.tabs.update(tabId, { active: true });
  if (!isNaN(windowId)) await chrome.windows.update(windowId, { focused: true });
});

// Close tab
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.sp-tab-close');
  if (!btn) return;
  const id = parseInt(btn.dataset.closeId);
  if (!isNaN(id)) await chrome.tabs.remove(id);
});

// Search
document.getElementById('spSearch')?.addEventListener('input', (e) => {
  renderTabList(e.target.value.trim());
});

// Auto-refresh on tab changes
function scheduleRefresh() {
  clearTimeout(scheduleRefresh._t);
  scheduleRefresh._t = setTimeout(() => renderTabList(document.getElementById('spSearch')?.value || ''), 300);
}
chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((_, c) => { if (c.url || c.title) scheduleRefresh(); });

// ---- AI Chat ----

let spMessages = [];

async function getApiKey() {
  try {
    const r = await chrome.storage.local.get('anthropicApiKey');
    return r.anthropicApiKey || '';
  } catch { return ''; }
}

function buildContext(tabs) {
  const grouped = {};
  for (const t of tabs) {
    let d;
    try { d = new URL(t.url).hostname; } catch { d = 'other'; }
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(t.title || t.url);
  }
  let ctx = `User has ${tabs.length} open tabs:\n`;
  for (const [d, titles] of Object.entries(grouped)) {
    ctx += `[${d}] ${titles.length}\n`;
    for (const t of titles) ctx += `  - ${t}\n`;
  }
  return ctx;
}

function appendMsg(role, text) {
  const el = document.getElementById('spChatMessages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = `sp-msg sp-msg-${role}`;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

document.getElementById('spChatForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('spChatInput');
  const text = input?.value.trim();
  if (!text) return;

  const apiKey = await getApiKey();
  if (!apiKey) { appendMsg('error', 'Set up your API key in the new tab page first.'); return; }

  input.value = '';
  appendMsg('user', text);
  const thinking = appendMsg('thinking', 'Thinking...');

  spMessages.push({ role: 'user', content: text });

  try {
    const tabs = await chrome.tabs.query({});
    const realTabs = tabs.filter(t => !t.url?.startsWith('chrome'));

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
        system: `You are Tidy Tabby AI, a concise assistant in a browser side panel.\n\n${buildContext(realTabs)}\n\nBe brief. Match the user's language.`,
        messages: spMessages,
      }),
    });

    if (!resp.ok) throw new Error(resp.status === 401 ? 'Invalid API key' : `Error ${resp.status}`);
    const data = await resp.json();
    const reply = data.content?.[0]?.text || 'No response.';
    spMessages.push({ role: 'assistant', content: reply });
    thinking?.remove();
    appendMsg('assistant', reply);
  } catch (err) {
    spMessages.pop();
    thinking?.remove();
    appendMsg('error', err.message);
  }
});

// ---- Init ----
renderTabList();
