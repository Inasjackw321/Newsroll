// Tiny dependency-free RSS 2.0 / Atom parser. It is intentionally forgiving:
// news feeds are messy and we only need a handful of fields.
const crypto = require('crypto');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', pound: '£', euro: '€', copy: '©',
};

function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function unwrapCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the inner text of the first <tag> found in xml (namespaced tags allowed).
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function attr(xml, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}=["']([^"']+)["'][^>]*>`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function clean(raw) {
  // Decode twice: many feeds double-escape HTML inside descriptions.
  return stripHtml(decodeEntities(stripHtml(decodeEntities(unwrapCdata(raw)))));
}

function atomLink(entry) {
  const links = entry.match(/<link\b[^>]*>/gi) || [];
  const alt = links.find((l) => /rel=["']alternate["']/i.test(l)) || links.find((l) => !/rel=/i.test(l)) || links[0];
  const m = alt && alt.match(/href=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

function findImage(block) {
  return (
    attr(block, 'media:thumbnail', 'url') ||
    attr(block, 'media:content', 'url') ||
    (/<enclosure\b[^>]*type=["']image/i.test(block) ? attr(block, 'enclosure', 'url') : '') ||
    (decodeEntities(unwrapCdata(block)).match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] ||
    ''
  );
}

function makeId(link, title) {
  return crypto.createHash('sha1').update(link || title).digest('hex').slice(0, 10);
}

function parseFeed(xml, sourceName) {
  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || [];
  const feedTitle = clean(tagText(xml.replace(/<(item|entry)\b[\s\S]*$/i, ''), 'title'));
  const source = sourceName || feedTitle || 'Unknown';

  return blocks
    .map((block) => {
      const title = clean(tagText(block, 'title'));
      const link = isAtom ? atomLink(block) : clean(tagText(block, 'link')) || clean(tagText(block, 'guid'));
      const summary = clean(
        tagText(block, 'description') || tagText(block, 'summary') ||
        tagText(block, 'content:encoded') || tagText(block, 'content'),
      );
      const dateRaw = clean(
        tagText(block, 'pubDate') || tagText(block, 'published') ||
        tagText(block, 'updated') || tagText(block, 'dc:date'),
      );
      const date = new Date(dateRaw);
      return {
        id: makeId(link, title),
        title,
        link,
        summary: summary.length > 600 ? summary.slice(0, 597) + '…' : summary,
        image: findImage(block),
        source,
        published: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      };
    })
    .filter((item) => item.title);
}

module.exports = { parseFeed, decodeEntities, stripHtml, makeId };
