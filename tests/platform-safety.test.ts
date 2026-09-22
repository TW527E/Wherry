import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, SafeHttp, validatePublicUrl, HttpError } from '../src/security/http.js';
import { cleanXLinks, fixupUrl, splitText, graphemes, normalizeText, similarity, htmlEscape } from '../src/text.js';
import { blueskyRecordKey } from '../src/platforms/bluesky.js';
import { fullSizeImageUrl, hasSensitiveWarning, parseTweetFacts } from '../src/platforms/x.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import { SharkeyClient } from '../src/platforms/sharkey.js';
import type { HttpOptions, HttpResponse, PreparedImage, Transport } from '../src/types.js';

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

test('X photo URLs are upgraded to original resolution, other URLs untouched', () => {
  // The blurry-thumbnail bug: the timeline <img> src carries a downscaled size in name=.
  assert.equal(fullSizeImageUrl('https://pbs.twimg.com/media/ABC123?format=jpg&name=small'),
    'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig');
  assert.equal(fullSizeImageUrl('https://pbs.twimg.com/media/ABC123?format=png&name=360x360'),
    'https://pbs.twimg.com/media/ABC123?format=png&name=orig');
  // A media URL with no size param still gets name=orig added.
  assert.equal(fullSizeImageUrl('https://pbs.twimg.com/media/ABC123.jpg'),
    'https://pbs.twimg.com/media/ABC123.jpg?name=orig');
  // Non-media pbs paths (profile/emoji) and non-pbs hosts are left alone.
  assert.equal(fullSizeImageUrl('https://pbs.twimg.com/profile_images/1/avatar.jpg'),
    'https://pbs.twimg.com/profile_images/1/avatar.jpg');
  // Non-public / disallowed hosts are still rejected exactly like validMediaUrl.
  assert.equal(fullSizeImageUrl('http://pbs.twimg.com/media/ABC?name=small'), undefined);
  assert.equal(fullSizeImageUrl('https://evil.example/media/ABC?name=small'), undefined);
  assert.equal(fullSizeImageUrl(undefined), undefined);
});

test('several images from one post go out as a single Telegram album with the caption on the first', async () => {
  const captured: Array<{ url: string; body: string }> = [];
  const transport: Transport = {
    async request(url: string, options?: HttpOptions): Promise<HttpResponse> {
      // sendMediaGroup uses multipart; capture enough to assert the media[] JSON shape.
      const body = options?.body instanceof Uint8Array ? new TextDecoder().decode(options.body) : String(options?.body ?? '');
      captured.push({ url, body });
      const result = [{ message_id: 41 }, { message_id: 42 }, { message_id: 43 }];
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
    },
    async json<T>() { throw new Error('unused') as T; },
  };
  const client = new TelegramClient(
    { enabled: true, token: '123:abc', ownerId: '1', privateChatId: '1', opsChatId: '', publicChatId: '555', pollCommands: false },
    transport,
  );
  const image = (n: number): PreparedImage => ({ bytes: new Uint8Array([n]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: String(n) });
  const ref = await client.publish(
    { key: 'k:0', sourcePostId: '9', text: '我的內文', images: [image(1), image(2), image(3)], sourceUrl: 'https://fixupx.com/owner/status/9' },
    { audience: 'public', idempotencyKey: 'k:0' },
  );
  assert.equal(captured.length, 1, 'three images are one album call, not three messages');
  assert.match(captured[0]!.url, /sendMediaGroup$/);
  assert.match(captured[0]!.body, /我的內文/, 'the tweet text is not lost');
  assert.match(captured[0]!.body, /原文連結/, 'the source link rides on the album caption');
  assert.match(captured[0]!.body, /attach:\/\/photo0/);
  assert.match(captured[0]!.body, /attach:\/\/photo2/);
  assert.deepEqual(ref.messageIds, [41, 42, 43], 'every album message id is recorded for threading');
});

test('Sharkey uploads media into the configured Drive folder, creating it once when absent', async () => {
  const calls: Array<{ method: string; body: string }> = [];
  const json = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
  let findCalls = 0;
  const transport: Transport = {
    async request(url: string, options?: HttpOptions): Promise<HttpResponse> {
      const method = url.split('/api/')[1] ?? url;
      const body = options?.body instanceof Uint8Array ? new TextDecoder().decode(options.body) : String(options?.body ?? '');
      calls.push({ method, body });
      if (method === 'users/show') return json({ id: 'user1', username: 'owner', host: null });
      if (method === 'meta') return json({ maxNoteTextLength: 3000, maxCwLength: 500, maxFileCommentLength: 2000, policies: { canPublicNote: true } });
      // First lookup finds nothing → the client must create the folder, then never create it twice.
      if (method === 'drive/folders/find') { findCalls++; return json([]); }
      if (method === 'drive/folders/create') return json({ id: 'folder1', name: 'Wherry', parentId: null });
      if (method === 'drive/files/create') return json({ id: 'file1', comment: null, isSensitive: false });
      if (method === 'notes/create') return json({ createdNote: { id: 'note1', uri: null } });
      throw new Error(`unexpected Sharkey call: ${method}`);
    },
    async json<T>() { throw new Error('unused') as T; },
  };
  const config = {
    enabled: true, baseUrl: 'https://sharkey.example', token: 'tok', userId: 'user1', username: 'owner',
    signature: '', driveFolder: 'Wherry', uploadName: 'Wherry_{timestamp}-{index}.{ext}',
  };
  const client = new SharkeyClient(config, transport, { now: () => new Date('2026-09-21T15:30:00.000Z') });
  const image: PreparedImage = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: '1' };
  const ref = await client.publish(
    { key: 'k:0', sourcePostId: '9', text: 'hello', images: [image], sourceUrl: 'https://fixupx.com/owner/status/9' },
    { audience: 'public', idempotencyKey: 'k:0' },
  );
  assert.equal(ref.id, 'note1');
  const upload = calls.find(c => c.method === 'drive/files/create');
  assert.ok(upload, 'the image is uploaded to the drive');
  assert.match(upload!.body, /name="folderId"\r\n\r\nfolder1/, 'the upload carries the resolved folder id');
  assert.match(upload!.body, /filename="Wherry_20260921T153000Z-0\.jpg"/, 'the filename follows the configured template');

  // A second publish on the same client reuses the cached folder id — no second find/create.
  await client.publish(
    { key: 'k:1', sourcePostId: '10', text: 'again', images: [image], sourceUrl: 'https://fixupx.com/owner/status/10' },
    { audience: 'public', idempotencyKey: 'k:1' },
  );
  assert.equal(findCalls, 1, 'the folder is resolved once and cached for later publishes');
  assert.equal(calls.filter(c => c.method === 'drive/folders/create').length, 1, 'the folder is created only once');
});

test('an empty SHARKEY_DRIVE_FOLDER uploads to the drive root with no folder lookup', async () => {
  const calls: string[] = [];
  const json = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
  const transport: Transport = {
    async request(url: string, options?: HttpOptions): Promise<HttpResponse> {
      const method = url.split('/api/')[1] ?? url;
      calls.push(method);
      if (method === 'users/show') return json({ id: 'user1', username: 'owner', host: null });
      if (method === 'meta') return json({ maxNoteTextLength: 3000, maxCwLength: 500, maxFileCommentLength: 2000, policies: { canPublicNote: true } });
      if (method === 'drive/files/create') {
        const body = options?.body instanceof Uint8Array ? new TextDecoder().decode(options.body) : '';
        assert.doesNotMatch(body, /name="folderId"/, 'no folder id is sent when uploading to the root');
        return json({ id: 'file1', comment: null, isSensitive: false });
      }
      if (method === 'notes/create') return json({ createdNote: { id: 'note1', uri: null } });
      throw new Error(`unexpected Sharkey call: ${method}`);
    },
    async json<T>() { throw new Error('unused') as T; },
  };
  const config = {
    enabled: true, baseUrl: 'https://sharkey.example', token: 'tok', userId: 'user1', username: 'owner',
    signature: '', driveFolder: '', uploadName: 'Wherry_{timestamp}-{index}.{ext}',
  };
  const client = new SharkeyClient(config, transport);
  const image: PreparedImage = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: '1' };
  await client.publish(
    { key: 'k:0', sourcePostId: '9', text: 'hello', images: [image], sourceUrl: 'https://fixupx.com/owner/status/9' },
    { audience: 'public', idempotencyKey: 'k:0' },
  );
  assert.ok(!calls.includes('drive/folders/find'), 'an empty folder name skips folder resolution entirely');
});

test('the X sensitive-media warning is recognised but ordinary post chrome is not', () => {
  // The warning X renders in place of media it has flagged, in both interfaces this collector sees.
  assert.equal(hasSensitiveWarning('The following media includes potentially sensitive content'), true);
  assert.equal(hasSensitiveWarning('This media may contain sensitive material'), true);
  assert.equal(hasSensitiveWarning('以下媒體可能包含敏感內容'), true);
  assert.equal(hasSensitiveWarning('這則貼文可能包含敏感內容'), true);
  // The collector passes the post's UI text with the tweet BODY removed, so these are the strings the
  // check actually sees for an ordinary post. None of them may be read as a sensitive flag.
  for (const chrome of ['誠誠-ChengCheng 💫@TW527E·1h12345', 'Replying to @someone', 'Show more', 'Translate post', 'Pinned', '1:23', '']) {
    assert.equal(hasSensitiveWarning(chrome), false, `ordinary chrome must not match: ${JSON.stringify(chrome)}`);
  }
});

test('the poll flag and sensitive label survive parsing into post facts', () => {
  const base = { id: '123', authorId: 'owner', createdAt: '2026-09-19T00:00:00.000Z' };
  // Both flags were previously never set for X posts: the collector did not detect either, so a poll
  // synced as its question alone and flagged media synced with no marking at all.
  const poll = parseTweetFacts({ ...base, text: 'which one', poll: true }, 'owner');
  assert.equal(poll.poll, true);
  assert.equal(poll.sensitive, false);
  const flagged = parseTweetFacts({ ...base, text: 'nsfw', labels: ['sensitive_media'] }, 'owner');
  assert.equal(flagged.sensitive, true);
  assert.equal(flagged.poll, false);
  const plain = parseTweetFacts({ ...base, text: 'hello' }, 'owner');
  assert.equal(plain.poll, false, 'a post with no poll widget is not a poll');
  assert.equal(plain.sensitive, false, 'a post with no warning is not sensitive');
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
