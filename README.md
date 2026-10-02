# Newsroll

A simple news reader laid out as a single vertical timeline. It pulls from 180+ news sites and Telegram channels. Each story is a small headline you can tap to expand, and a local language model running in [Ollama](https://ollama.com) (by default [`smollm2`](https://ollama.com/library/smollm2)) adds briefings, Q&A and explanations. Everything runs on your own machine.

## Download the app

Newsroll is a desktop app for **Mac, Windows and Linux**. Get the installer from the [**Releases page**](https://github.com/Inasjackw321/Newsroll/releases/latest):

| System | File | How to install |
| --- | --- | --- |
| **Mac** (M1 or newer) | `Newsroll-…-mac-arm64.dmg` | Open it and drag **Newsroll** into Applications |
| **Mac** (Intel) | `Newsroll-…-mac-x64.dmg` | Same as above |
| **Windows** | `Newsroll-…-win-x64.exe` | Double-click it. It installs and opens, with Start menu and desktop shortcuts |
| **Linux** | `Newsroll-…-linux-x86_64.AppImage` | Make it executable (`chmod +x`), then double-click it |

After that, open Newsroll like any other app from the Dock, the Start menu or the app launcher. Nothing needs starting in a terminal.

**For the AI features**, open **Settings → ✦ AI model** in the app and follow the three steps. You install the free [Ollama](https://ollama.com/download) app, then pick a model to download right there. No terminal needed. Newsroll starts Ollama for you each time it opens. Without it, the news still works.

**First launch warnings.** The app isn't signed with a paid Apple or Microsoft certificate, so your computer will warn you the first time:
- **Mac:** right-click Newsroll in Applications → **Open** → **Open**. If macOS says the app is "damaged", run `xattr -cr /Applications/Newsroll.app` in Terminal.
- **Windows:** click **More info** → **Run anyway**.


## Run from source

Requires Node 18+.

```bash
npm install
npm run app     # the desktop app
npm start       # or the browser version at http://localhost:3000
npm run dist    # build an installer for this computer into dist/
```

The browser version can also be installed as a web app: click the install icon in Chrome's or Edge's address bar. It only listens on this computer. Set `HOST=0.0.0.0` to open it to other devices on your network.

If none of the feeds can be fetched (for example when you're offline), Newsroll shows built-in sample stories.

### Publishing a new version

Bump `version` in `package.json` (e.g. to `0.2.0`) and push to `main`. GitHub Actions (`.github/workflows/release.yml`) builds the Mac, Windows and Linux installers and publishes them as release `v0.2.0`. Each build takes about 10 minutes.

## Sources

Open **Settings** (the sliders icon at the top right) → **News sources**.

- **181 built-in sources** in 18 groups: top stories, the US, UK, Europe, Asia & Pacific, the Americas, Middle East & Africa, business, tech, science, climate, health, sports, culture & games, good news, fact checks, Reddit and Telegram. A balanced set of 23 is on to start. Flip any switch, or use **Turn all on** for a whole group.
- **Add your own.** Paste almost anything into the box:
  - a website (`npr.org`). Newsroll finds its feed for you.
  - an RSS or Atom link
  - a public **Telegram channel**: `@channel`, `t.me/channel` or the full link
- Each source shows how many stories it loaded, or **Couldn't load** if a site is down or has moved its feed.

**Telegram** channels are read from their public web page (`t.me/s/<channel>`), so you don't need a Telegram account. Their posts appear in the timeline with a small *Telegram* tag, and a **Telegram** filter chip appears at the top. Only public channels work. Private channels and groups can't be read this way.

## Choosing the AI

Open **Settings → ✦ AI model**:

- **Your models** lists what's installed. Tap one to switch.
- **Get more models** offers a few picks, from the tiny SmolLM2 Mini (0.7 GB) to Mistral 7B (4.1 GB). Click **Download** to watch the progress, and Newsroll switches to the new model when it finishes.
- Or type any model name from [ollama.com/library](https://ollama.com/library).

Your choice is saved and used for summaries, answers and explanations.

## Using it

The screen has three parts:

1. **Topics**: tap a chip to filter the timeline. Tap the 🔍 icon (or press `/`) to search headlines and sources.
2. **✦ Summary button**: one tap for an AI summary. It adapts to what's most useful: *Summarize today*, *Catch up on N new stories* (since your last visit) or *Summarize Tech* when a topic is selected.
3. **The timeline**: stories grouped by day. Tap a headline to expand it, then use **✦ Explain** for a *TL;DR / Why it matters / Watch for* breakdown, or **Open story** for the original article. Each day also has a **✦ Summary** button.

At the bottom there's an **Ask about the news** box. Type a question, or pick a suggested one, and the answer slides up with numbered citations. Tap a citation to jump to that story.

**Design:** black and white with plain text. Colour (a violet-to-teal accent) only appears on AI features. The dot in the **N.** logo lights up while the AI is thinking.

**Smart touches:** the Ask feature picks only the most relevant stories, so a small model like smollm2 stays accurate. Related stories and suggested questions are worked out instantly, with no model call. Stories that are new since your last visit are marked, and feeds refresh every 5 minutes. If you've scrolled down, a "N new stories" pill appears instead of the page jumping.

**Animations:** stories rise in as you scroll, the timeline line fills as you read, stories expand smoothly, answers type out live and the Ask panel slides up. If your system is set to reduce motion, all of this is turned off.

**Keyboard:** `j` / `k` move between stories, `Enter` expands one, `/` searches, `Ctrl/⌘ K` asks a question, `Ctrl/⌘ ,` opens sources (desktop app) and `Esc` closes whatever's open.

## Configuration

| Variable       | Default                  | Description                         |
| -------------- | ------------------------ | ----------------------------------- |
| `PORT`         | `3000`                   | HTTP port (browser version)         |
| `HOST`         | `127.0.0.1`              | Interface to listen on (browser version) |
| `OLLAMA_HOST`  | `http://127.0.0.1:11434` | Where Ollama is running             |
| `OLLAMA_MODEL` | `smollm2`                | Default model until you pick one in Settings |
| `NEWSROLL_DATA`| `./data`                 | Where settings are saved (the desktop app uses your system's app-data folder) |

To change the built-in source list, edit `lib/catalog.js`.

## How it works

```
electron/        Desktop app: starts the server in-process and opens a native window
server.js        HTTP server: static files, /api/feed, /api/ai/* (streams model output)
lib/rss.js       Dependency-free RSS/Atom parser
lib/telegram.js  Reads public Telegram channels from t.me/s/<channel>
lib/catalog.js   The built-in list of 181 sources
lib/settings.js  Saves enabled sources, added sources and the chosen model
lib/topics.js    Keyword topic tagging
lib/ai.js        Prompts, relevance ranking and Ollama streaming
lib/sample.js    Offline sample stories
public/          The app: index.html, styles.css, app.js, the service worker
                 (sw.js), manifest and icons
```

The server fetches the enabled sources 12 at a time, caches them for 5 minutes, merges duplicate headlines and keeps up to 800 stories from the last 2 days. Summaries pick at most two stories per source, so one busy feed can't dominate. The AI endpoints build short, numbered prompts sized for small models, then stream Ollama's output straight to the browser. The IDs of the stories the model saw are sent in a response header, which is how the browser turns `[n]` into links.

## Tests

```bash
npm test
```
