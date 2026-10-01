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

If Ollama isn't running, the timeline still works and the AI pill in the header tells you what's missing. If none of the feeds can be fetched (for example when you're offline), Newsroll shows built-in sample stories so you can still try it out.

## Features

**Timeline**
- One vertical timeline grouped by day and hour, with a "Now" marker at the top. Day headers stay pinned while you scroll.
- Small headlines that expand smoothly to show the summary, image, source link and related stories.
- Topic filter chips (Politics, World, Business, Tech, …), colour-coded on the timeline.
- Stories published since your last visit get a pulsing dot and a **New** tag.
- Feeds refresh every 5 minutes. If you've scrolled down, a "N new stories" pill appears instead of the page jumping.
- Keyboard shortcuts: `j` / `k` to move between stories, `Enter` to expand, `/` to jump to the question box.

**AI (local, via Ollama)**
- **Daily briefing**: a streamed summary of today, of everything *since your last visit*, or of the current topic.
- **Summarize a day**: every day header on the timeline has a ✦ button that summarises just that day.
- **Ask**: ask a question in plain language. Newsroll first picks the most relevant stories by keyword overlap, so a small model only has to read a few, and the answer cites them.
- **Clickable citations**: `[2]`-style references in any AI answer become chips. Clicking one scrolls to that story, opens it and highlights it.
- **Explain this**: each story can be expanded into *TL;DR / Why it matters / Watch for*.
- **Suggested questions** built from the topics and names that keep coming up in the headlines.
- **Related stories**: found instantly by keyword similarity, with no model call.

**Animations**
Cards rise in with a stagger as they scroll into view, and the timeline line fills with colour as you read down it. There's also a scroll progress bar, smooth expand and collapse, a typing cursor while answers stream, a "thinking" indicator, a highlight flash when you jump to a story and shimmer placeholders while loading. If your system is set to reduced motion, all of this is turned off.

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
public/          The front end (index.html, styles.css, app.js)
```

The server caches feeds for 5 minutes and keeps stories from the last 3 days. The AI endpoints build short, numbered prompts sized for small models, then stream Ollama's output straight to the browser. The IDs of the stories the model saw are sent in a response header, which is how the browser turns `[n]` into links.

## Tests

```bash
npm test
```
