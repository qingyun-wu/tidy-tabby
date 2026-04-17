# AGENTS.md -- Tidy Tabby: Setup & Onboarding Guide for Coding Agents

You're installing **Tidy Tabby** for the user. Your job is not just to set it up -- it's to get them excited about using it.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Tidy Tabby** replaces your new tab page with a clean dashboard of everything you have open, grouped by domain.
>
> Here's what makes it great:
> - **See all your open tabs at a glance** grouped by domain on a grid
> - **Homepages group** pulls Gmail, X, LinkedIn, YouTube, GitHub homepages into one card for easy cleanup
> - **Close tabs with style** satisfying swoosh sound + confetti burst
> - **Duplicate detection** flags when you have the same page open twice
> - **Click any tab title to jump to it** even across different Chrome windows
> - **Save for later** bookmark individual tabs to a checklist before closing them
> - **100% local** no server, no accounts, no data sent anywhere
>
> It's just a Chrome extension. Setup takes about 1 minute.

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
```

---

## Step 2 -- Install the Chrome extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:
```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:
- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extensions page:
```bash
open "chrome://extensions"
```

**Then**, walk the user through it step by step:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. You should see Chrome's extensions page. In the **top-right corner**, toggle on **Developer mode** (it's a switch).
> 2. Once Developer mode is on, you'll see a button called **"Load unpacked"** appear in the top-left. Click it.
> 3. A file picker will open. **Press Cmd+Shift+G** (Mac) or **Ctrl+L** (Windows/Linux) to open the "Go to folder" bar, then **paste** the path I copied (Cmd+V / Ctrl+V) and press Enter.
> 4. Click **"Select"** or **"Open"** and the extension will install.
>
> You should see "Tidy Tabby" appear in your extensions list.

**Also**, open the file browser directly to the extension folder as a fallback:
- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them around

Once the extension is loaded:

> You're all set! Open a **new tab** and you'll see Tidy Tabby.
>
> Here's how it works:
> 1. **Your open tabs are grouped by domain** in a grid layout.
> 2. **Homepages** (Gmail inbox, X home, YouTube, etc.) are in their own group at the top.
> 3. **Click any tab title** to jump directly to that tab.
> 4. **Click the X** next to any tab to close just that one (with swoosh + confetti).
> 5. **Click "Close all N tabs"** on a group to close the whole thing.
> 6. **Duplicate tabs** are flagged with an amber "(2x)" badge. Click "Close duplicates" to keep one copy.
> 7. **Save a tab for later** by clicking the bookmark icon before closing it. Saved tabs appear in the sidebar.
>
> That's it! No server to run, no config files. Everything works right away.

---

## Step 4 -- Set up Claude Code in the browser (automatic)

After the extension is loaded, set up native messaging so the Claude Code tab works:

```bash
# Get the extension ID from Chrome
EXTENSION_ID=$(ls ~/Library/Application\ Support/Google/Chrome/Default/Extensions/ 2>/dev/null | grep -v Temp | tail -1)
# Or on Linux: ls ~/.config/google-chrome/Default/Extensions/

# Run the install script with the extension ID
./install-terminal.sh "$EXTENSION_ID"
```

If the auto-detect doesn't work, find the ID manually:
1. Open `chrome://extensions`
2. Find "Tidy Tabby" and copy its ID
3. Run: `./install-terminal.sh <paste-id-here>`

Then reload the extension in `chrome://extensions`.

> The **Claude Code** tab is now ready. Click it and hit Connect — if Claude Code is installed, it launches directly. Otherwise you get a regular shell.

---

## Key Facts

- Tidy Tabby is a pure Chrome extension. No server, no Node.js, no npm.
- Saved tabs are stored in `chrome.storage.local` (persists across sessions).
- 100% local. No data is sent to any external service.
- The Claude Code tab uses Chrome Native Messaging — requires a one-time `install-terminal.sh` setup.
- To update: `cd tab-out && git pull`, then reload the extension in `chrome://extensions`.
