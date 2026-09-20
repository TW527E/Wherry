import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, SafeHttp, validatePublicUrl, HttpError } from '../src/security/http.js';
import { cleanXLinks, fixupUrl, splitText, graphemes, normalizeText, similarity, htmlEscape } from '../src/text.js';
import { blueskyRecordKey } from '../src/platforms/bluesky.js';

test('blueskyRecordKey produces a valid, deterministic TID', () => {
  // app.bsky.feed.post requires a TID rkey (13-char base32-sortable, top bit clear).
  const tid = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
  const a = blueskyRecordKey('job1:part0');
  assert.match(a, tid);
  assert.equal(a, blueskyRecordKey('job1:part0'), 'same idempotency key must yield the same rkey (retry safety)');
  assert.notEqual(a, blueskyRecordKey('job1:footer'), 'different keys must differ');
  assert.throws(() => blueskyRecordKey(''), /idempotency key/);
});

test('blocked address ranges are rejected', () => {
  for (const value of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.5', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '2002::1', 'ff02::1']) {
    assert.equal(isPublicAddress(value), false, `${value} must be blocked`);
  }
  for (const value of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(value), true, `${value} must be allowed`);
  }
});

test('URL validation rejects non-public and credential-bearing targets', async () => {
  const resolver = async (hostname: string) => hostname === 'rebind.example' ? [{ address: '10.0.0.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
  await assert.rejects(() => validatePublicUrl('http://localhost/x', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('http://127.0.0.1/x', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('http://[::1]/x', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('http://169.254.169.254/latest/meta-data', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('file:///etc/passwd', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('https://user:pass@example.com/x', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('https://example.com:8443/x', resolver), HttpError);
  await assert.rejects(() => validatePublicUrl('http://rebind.example/x', resolver), HttpError);
  const allowed = await validatePublicUrl('https://example.com/x', resolver);
  assert.equal(allowed.url.hostname, 'example.com');
});

test('the transport refuses to send credentials over plain HTTP', async () => {
  const http = new SafeHttp(async () => [{ address: '93.184.216.34', family: 4 }]);
  await assert.rejects(() => http.request('http://example.com/x', { headers: { authorization: 'Bearer secret' } }), HttpError);
  await assert.rejects(() => http.request('http://example.com/x', { method: 'POST' }), HttpError);
});

test('fixupx rewriting only touches genuine X status links and drops tracking parameters', () => {
  assert.equal(fixupUrl('https://x.com/alice/status/1234567890?s=20&t=abc'), 'https://fixupx.com/alice/status/1234567890');
  assert.equal(fixupUrl('https://twitter.com/alice/status/123/photo/1'), 'https://fixupx.com/alice/status/123');
  assert.equal(fixupUrl('https://mobile.twitter.com/alice/status/42'), 'https://fixupx.com/alice/status/42');
  assert.equal(fixupUrl('https://x.com/alice'), undefined);
  assert.equal(fixupUrl('https://x.com.evil.example/alice/status/1'), undefined);
  assert.equal(fixupUrl('https://example.com/alice/status/1'), undefined);
  assert.equal(fixupUrl('javascript:alert(1)'), undefined);
});

test('link cleaning rewrites X URLs but preserves other links and punctuation', () => {
  const input = 'see https://x.com/a/status/99?s=20 and https://example.com/p?q=1, ok';
  const output = cleanXLinks(input);
  assert.match(output, /https:\/\/fixupx\.com\/a\/status\/99/);
  assert.doesNotMatch(output, /s=20/);
  assert.match(output, /https:\/\/example\.com\/p\?q=1,/);
});

test('normalization is stable but keeps semantic query parameters', () => {
  assert.equal(normalizeText('  hello   world  '), 'hello world');
  assert.match(normalizeText('https://example.com/p?a=1&b=2'), /a=1&b=2/);
  assert.ok(similarity('the quick brown fox', 'the quick brown fox') > 0.9);
  assert.ok(similarity('the quick brown fox', 'completely different text') < 0.2);
});

test('text splitting respects graphemes, bytes and never corrupts URLs', () => {
  const text = '😀'.repeat(400);
  const chunks = splitText(text, { graphemes: 300 });
  assert.equal(chunks.length, 2);
  assert.equal(graphemes(chunks[0]!).length, 300);
  const long = `start ${'あ'.repeat(2000)} end`;
  for (const chunk of splitText(long, { utf8Bytes: 3000 })) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 3000);
  const withUrl = `see https://example.com/${'x'.repeat(200)} here`;
  assert.deepEqual(splitText(withUrl, { utf16: 4096 }), [withUrl]);
  assert.throws(() => splitText(`https://example.com/${'y'.repeat(50)}`, { utf16: 20 }), /URL exceeds|single grapheme/);
});

test('html escaping expands predictable characters only', () => {
  assert.equal(htmlEscape('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});
