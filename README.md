# Newsroll

A minimal RSS news reader laid out as a single vertical timeline. Each story is a small headline you can tap to expand, and a local language model running in [Ollama](https://ollama.com) (by default [`smollm2`](https://ollama.com/library/smollm2)) adds briefings, Q&A and explanations. Everything runs on your own machine.

## Download the app

Newsroll is a desktop app for **Mac, Windows and Linux**. Get the installer from the [**Releases page**](https://github.com/Inasjackw321/Newsroll/releases/latest):

| System | File | How to install |
| --- | --- | --- |
| **Mac** (M1 or newer) | `Newsroll-…-mac-arm64.dmg` | Open it and drag **Newsroll** into Applications |
| **Mac** (Intel) | `Newsroll-…-mac-x64.dmg` | Same as above |
| **Windows** | `Newsroll-…-win-x64.exe` | Double-click it. It installs and opens, with Start menu and desktop shortcuts |
| **Linux** | `Newsroll-…-linux-x86_64.AppImage` | Make it executable (`chmod +x`), then double-click it |

After that, open Newsroll like any other app from the Dock, the Start menu or the app launcher. Nothing needs starting in a terminal.

**For the AI features**, install [Ollama](https://ollama.com/download) once and run `ollama pull smollm2`. Newsroll starts Ollama for you when it opens. Without it, the news still works and the Ask panel explains what's missing.

**First launch warnings.** The app isn't signed with a paid Apple or Microsoft certificate, so your computer will warn you the first time:
- **Mac:** right-click Newsroll in Applications → **Open** → **Open**. If macOS says the app is "damaged", run `xattr -cr /Applications/Newsroll.app` in Terminal.
- **Windows:** click **More info** → **Run anyway**.

**Changing news sources:** in the app, choose **File → Edit News Sources…**, edit the list and press refresh.

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

## Using it

The screen has three parts:

1. **Topics**: tap a chip to filter the timeline.
2. **✦ Summary button**: one tap for an AI summary. It adapts to what's most useful: *Summarize today*, *Catch up on N new stories* (since your last visit) or *Summarize Tech* when a topic is selected.
3. **The timeline**: stories grouped by day. Tap a headline to expand it, then use **✦ Explain** for a *TL;DR / Why it matters / Watch for* breakdown, or **Open story** for the original article. Each day also has a **✦ Summary** button.

At the bottom there's an **Ask about the news** box. Type a question, or pick a suggested one, and the answer slides up with numbered citations. Tap a citation to jump to that story.

**Design:** black and white with plain text. Colour (a violet-to-teal accent) only appears on AI features. The dot in the **N.** logo lights up while the AI is thinking.

**Smart touches:** the Ask feature picks only the most relevant stories, so a small model like smollm2 stays accurate. Related stories and suggested questions are worked out instantly, with no model call. Stories that are new since your last visit are marked, and feeds refresh every 5 minutes. If you've scrolled down, a "N new stories" pill appears instead of the page jumping.

**Animations:** stories rise in as you scroll, the timeline line fills as you read, stories expand smoothly, answers type out live and the Ask panel slides up. If your system is set to reduce motion, all of this is turned off.

**Keyboard:** `j` / `k` move between stories, `Enter` expands one, `/` asks a question and `Esc` closes the panel.

## Configuration

| Variable       | Default                  | Description                         |
| -------------- | ------------------------ | ----------------------------------- |
| `PORT`         | `3000`                   | HTTP port (browser version)         |
| `HOST`         | `127.0.0.1`              | Interface to listen on (browser version) |
| `OLLAMA_HOST`  | `http://127.0.0.1:11434` | Where Ollama is running             |
| `OLLAMA_MODEL` | `smollm2`                | Any chat model you've pulled, e.g. `smollm2:360m` for speed or `llama3.2` for quality |

Edit `feeds.json` to change the news sources. Any RSS 2.0 or Atom feed works:

```json
[{ "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/rss.xml" }]
```

## How it works

```
electron/        Desktop app: starts the server in-process and opens a native window
server.js        HTTP server: static files, /api/feed, /api/ai/* (streams model output)
lib/rss.js       Dependency-free RSS/Atom parser
lib/topics.js    Keyword topic tagging
lib/ai.js        Prompts, relevance ranking and Ollama streaming
lib/sample.js    Offline sample stories
public/          The app: index.html, styles.css, app.js, the service worker
                 (sw.js), manifest and icons
```

The server caches feeds for 5 minutes and keeps stories from the last 3 days. The AI endpoints build short, numbered prompts sized for small models, then stream Ollama's output straight to the browser. The IDs of the stories the model saw are sent in a response header, which is how the browser turns `[n]` into links.

## Tests

```bash
npm test
```
