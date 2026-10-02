# Newsroll

A minimal RSS news reader laid out as a single vertical timeline. Each story is a small headline you can tap to expand, and a local language model running in [Ollama](https://ollama.com) (by default [`smollm2`](https://ollama.com/library/smollm2)) adds briefings, Q&A and explanations. Everything runs on your own machine.

There are no dependencies to install. It's a single Node server plus plain HTML, CSS and JS.

## Quick start

```bash
# 1. Install Ollama (https://ollama.com/download), then pull the model
ollama pull smollm2

# 2. Run Newsroll (Node 18+)
npm start
# → http://localhost:3000
```

If Ollama isn't running, the news still works and the Ask panel tells you what to run. If none of the feeds can be fetched (for example when you're offline), Newsroll shows built-in sample stories so you can still try it out.

## Install it as an app

Newsroll is a Progressive Web App, so it installs with its own **N.** icon and window and opens even when you're offline.

- **Desktop (Chrome / Edge):** open `http://localhost:3000` and click the install icon in the address bar.
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu → *Install app*.

Browsers only allow installing from `localhost` or over HTTPS. To use it on your phone, put it behind HTTPS (for example with a reverse proxy or a tunnel).

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
| `PORT`         | `3000`                   | HTTP port                           |
| `OLLAMA_HOST`  | `http://127.0.0.1:11434` | Where Ollama is running             |
| `OLLAMA_MODEL` | `smollm2`                | Any chat model you've pulled, e.g. `smollm2:360m` for speed or `llama3.2` for quality |

Edit `feeds.json` to change the news sources. Any RSS 2.0 or Atom feed works:

```json
[{ "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/rss.xml" }]
```

## How it works

```
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
