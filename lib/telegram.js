// Reads public Telegram channels through their web preview (t.me/s/<name>),
// so no Telegram account or API key is needed.
const { decodeEntities, stripHtml, makeId } = require('./rss');

// Accepts "@name", "name", "t.me/name", "https://t.me/s/name" etc.
function channelName(input) {
  const m = String(input || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})|^@?([A-Za-z0-9_]{4,})$/);
  return m ? m[1] || m[2] : null;
}

const previewUrl = (name) => `https://t.me/s/${name}`;

// Turns a post's text into a short headline: first line or sentence.
function headline(text) {
  const first = text.split(/\n/).map((l) => l.trim()).find(Boolean) || '';
  const sentence = first.match(/^(.{20,}?[.!?])(\s|$)/);
  let title = sentence ? sentence[1] : first;
  if (title.length > 140) title = title.slice(0, 137).replace(/\s+\S*$/, '') + '…';
  return title;
}

function parseTelegram(html, fallbackName) {
  const channelTitle = decodeEntities((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').trim();
  const source = channelTitle || `@${fallbackName}`;
  const blocks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);

  return blocks
    .map((block) => {
      const post = (block.match(/data-post="([^"]+)"/) || [])[1];
      const date = (block.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
      const textHtml = (block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
      // Keep line breaks: they separate a post's headline from its body.
      const text = textHtml
        .split(/<br\s*\/?>/i)
        .map((part) => decodeEntities(stripHtml(part)))
        .join('\n')
        .trim();
      if (!post || !text) return null;
      const image = (block.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/) || [])[1] || '';
      const link = `https://t.me/${post}`;
      const title = headline(text);
      const rest = text.replace(/\s+/g, ' ').trim();
      return {
        id: makeId(link, title),
        title,
        link,
        summary: rest.length > 600 ? rest.slice(0, 597) + '…' : rest === title ? '' : rest,
        image,
        source,
        published: date ? new Date(date).toISOString() : null,
        type: 'telegram',
      };
    })
    .filter(Boolean)
    .reverse(); // the page lists oldest first
}

module.exports = { parseTelegram, channelName, previewUrl, headline };
