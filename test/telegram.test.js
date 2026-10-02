const test = require('node:test');
const assert = require('node:assert');
const { parseTelegram, channelName, headline } = require('../lib/telegram');

// Trimmed-down copy of the markup t.me/s/<channel> serves.
const HTML = `<html><head><meta property="og:title" content="Example News &amp; Co"></head><body>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="examplenews/101">
  <a class="tgme_widget_message_photo_wrap" style="width:800px;background-image:url('https://cdn.example/photo1.jpg')"></a>
  <div class="tgme_widget_message_text js-message_text" dir="auto"><b>Storm hits the coast.</b> Thousands evacuated overnight.<br/><br/>Emergency shelters are open &amp; roads closed.</div>
  <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/examplenews/101"><time datetime="2026-10-01T08:00:00+00:00" class="time">08:00</time></a></div>
</div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="examplenews/102">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Markets open higher</div>
  <div class="tgme_widget_message_footer"><time datetime="2026-10-01T09:30:00+00:00" class="time">09:30</time></div>
</div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="examplenews/103">
  <div class="tgme_widget_message_footer"><time datetime="2026-10-01T10:00:00+00:00">10:00</time></div>
</div></div>
</body></html>`;

test('parses public channel posts, newest first', () => {
  const items = parseTelegram(HTML, 'examplenews');
  assert.strictEqual(items.length, 2); // the photo-only post without text is skipped
  const [newest, older] = items;
  assert.strictEqual(newest.title, 'Markets open higher');
  assert.strictEqual(newest.link, 'https://t.me/examplenews/102');
  assert.strictEqual(newest.summary, '');
  assert.strictEqual(older.title, 'Storm hits the coast.');
  assert.match(older.summary, /Thousands evacuated overnight\. Emergency shelters are open & roads closed\./);
  assert.strictEqual(older.image, 'https://cdn.example/photo1.jpg');
  assert.strictEqual(older.source, 'Example News & Co');
  assert.strictEqual(older.published, '2026-10-01T08:00:00.000Z');
  assert.strictEqual(older.type, 'telegram');
});

test('understands the different ways people write a channel', () => {
  for (const input of ['@durov', 'durov', 't.me/durov', 'https://t.me/durov', 'https://t.me/s/durov', 'telegram.me/durov']) {
    assert.strictEqual(channelName(input), 'durov', input);
  }
  assert.strictEqual(channelName('https://example.com/feed'), null);
  assert.strictEqual(channelName('ab'), null);
});

test('makes short headlines from long posts', () => {
  assert.strictEqual(headline('Short one'), 'Short one');
  assert.strictEqual(headline('This is the first sentence of it. And then more text.'), 'This is the first sentence of it.');
  assert.ok(headline('word '.repeat(60)).length <= 141);
});
