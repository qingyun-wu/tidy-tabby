# Tidy Tabby 🐱

**Tidy Tabby keeps your tabs tidy.**

Tidy Tabby is a Chrome extension that turns your new tab page into a personal dashboard — open tabs, browsing history, bookmarks, and an AI assistant, all in one place.

---

## Features

- **Open Tabs** — grouped by domain, with search, staleness indicators, and Chrome tab group support
- **Recent Activity** — browsing history by site or by session, with "away from browser" time tracking
- **Bookmarks** — organized by folder, with search, AI-powered cleanup suggestions, and one-click management
- **Tabby Chat** — AI assistant that knows your tabs and browsing context
- **Side Panel** — lightweight tab list + AI chat in the browser sidebar, auto-summarizes the current page
- **Privacy Mode** — one-click screen cover with AI assistant, toggle with Esc
- **Dark Mode** — follows system preference
- **Auto-refresh** — dashboard updates live as you open/close tabs
- **100% local storage** — no accounts, no server, no tracking

---

## Setup

**1. Clone the repo**

```bash
git clone https://github.com/qingyun-wu/tidy-tabby.git
cd tidy-tabby
```

**2. Load the Chrome extension**

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the `extension/` folder

**3. Open a new tab** — you'll see Tidy Tabby.

---

## AI Features

Tabby Chat and AI-powered features require an [Anthropic API key](https://console.anthropic.com/). Enter it in the Tabby Chat tab — stored locally, never sent anywhere except Anthropic's API.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| AI | Anthropic Claude API (optional) |
| Sound | Web Audio API (synthesized) |
| Animations | CSS transitions + JS confetti |

---

## License

MIT — see [LICENSE](LICENSE)

---

Built by [Qingyun Wu](https://github.com/qingyun-wu) · based on [Tab Out](https://github.com/zarazhangrui/tab-out) by [Zara](https://x.com/zarazhangrui)
