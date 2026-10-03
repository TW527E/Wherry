import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, SafeHttp, validatePublicUrl, HttpError } from '../src/security/http.js';
import { cleanXLinks, fixupUrl, splitText, graphemes, normalizeText, similarity, htmlEscape } from '../src/text.js';
import { blueskyRecordKey } from '../src/platforms/bluesky.js';
import { fullSizeImageUrl, hasSensitiveWarning, isVideoPoster, parseTweetFacts, pickMedia, syndicationToken } from '../src/platforms/x.js';
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
  };
  const client = new TelegramClient(
    { enabled: true, token: '123:abc', ownerId: '1', privateChatId: '1', opsChatId: '', publicChatId: '555', pollCommands: false },
    transport,
  );
  const image = (n: number): PreparedImage => ({ bytes: new Uint8Array([n]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: String(n) });
  const ref = await client.publish(
    { key: 'k:0', sourcePostId: '9', text: '我的內文', media: [image(1), image(2), image(3)], sourceUrl: 'https://fixupx.com/owner/status/9', sensitive: true },
    { audience: 'public', idempotencyKey: 'k:0' },
  );
  assert.equal(captured.length, 1, 'three images are one album call, not three messages');
  assert.match(captured[0]!.url, /sendMediaGroup$/);
  assert.match(captured[0]!.body, /我的內文/, 'the tweet text is not lost');
  assert.match(captured[0]!.body, /原文連結/, 'the source link rides on the album caption');
  assert.match(captured[0]!.body, /attach:\/\/photo0/);
  assert.match(captured[0]!.body, /attach:\/\/photo2/);
  assert.match(captured[0]!.body, /has_spoiler/, 'a flagged post sends its album with a spoiler');
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
      // The upload echoes back isSensitive, which the client checks against the flag it sent.
      if (method === 'drive/files/create') return json({ id: 'file1', comment: null, isSensitive: true });
      if (method === 'notes/create') return json({ createdNote: { id: 'note1', uri: null } });
      throw new Error(`unexpected Sharkey call: ${method}`);
    },
  };
  const config = {
    enabled: true, baseUrl: 'https://sharkey.example', token: 'tok', userId: 'user1', username: 'owner',
    signature: '', driveFolder: 'Wherry', uploadName: 'Wherry_{timestamp}-{index}.{ext}',
  };
  const client = new SharkeyClient(config, transport, { now: () => new Date('2026-09-21T15:30:00.000Z') });
  const image: PreparedImage = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: '1' };
  const ref = await client.publish(
    { key: 'k:0', sourcePostId: '9', text: 'hello', media: [image], sourceUrl: 'https://fixupx.com/owner/status/9', sensitive: true },
    { audience: 'public', idempotencyKey: 'k:0' },
  );
  assert.equal(ref.id, 'note1');
  const upload = calls.find(c => c.method === 'drive/files/create');
  assert.ok(upload, 'the image is uploaded to the drive');
  assert.match(upload!.body, /name="folderId"\r\n\r\nfolder1/, 'the upload carries the resolved folder id');
  assert.match(upload!.body, /filename="Wherry_20260921T153000Z-0\.jpg"/, 'the filename follows the configured template');
  assert.match(upload!.body, /name="isSensitive"\r\n\r\ntrue/, 'a flagged post marks its drive file sensitive');

  // A second publish on the same client reuses the cached folder id — no second find/create.
  await client.publish(
    { key: 'k:1', sourcePostId: '10', text: 'again', media: [image], sourceUrl: 'https://fixupx.com/owner/status/10' },
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
  };
  const config = {
    enabled: true, baseUrl: 'https://sharkey.example', token: 'tok', userId: 'user1', username: 'owner',
    signature: '', driveFolder: '', uploadName: 'Wherry_{timestamp}-{index}.{ext}',
  };
  const client = new SharkeyClient(config, transport);
  const image: PreparedImage = { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', alt: '', width: 4, height: 4, sha256: '1' };
  await client.publish(
    { key: 'k:0', sourcePostId: '9', text: 'hello', media: [image], sourceUrl: 'https://fixupx.com/owner/status/9' },
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

test('an X video resolves to the best MP4 the download budget can afford; a GIF resolves to none', () => {
  // Shape taken verbatim from a live syndication tweet-result payload: one HLS entry with no bitrate
  // plus progressive MP4 renditions up to 4K. X serves no downloadable video in the page itself.
  const payload = (type: string): unknown => ({ mediaDetails: [{ type, original_info: { width: 3840, height: 2160 },
    video_info: { duration_millis: 20_000, variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/1/pl/a.m3u8' },
      { content_type: 'video/mp4', bitrate: 832_000, url: 'https://video.twimg.com/amplify_video/1/vid/avc1/640x360/b.mp4' },
      { content_type: 'video/mp4', bitrate: 2_176_000, url: 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/c.mp4' },
      { content_type: 'video/mp4', bitrate: 25_128_000, url: 'https://video.twimg.com/amplify_video/1/vid/avc1/3840x2160/d.mp4' },
    ] } }] });

  // 20s at 2.176 Mbit/s ≈ 5.4 MB and fits; the 4K rendition ≈ 63 MB and must never be chosen, or a
  // single clip would eat the whole download budget to produce the same 1280-capped output.
  const chosen = pickMedia(payload('video'), 20_000_000)?.[0];
  assert.equal(chosen?.url, 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/c.mp4');
  assert.equal(chosen?.durationSeconds, 20);
  assert.equal(chosen?.kind, 'video');
  assert.equal(chosen?.animated, false);
  assert.deepEqual([chosen?.width, chosen?.height], [3840, 2160]);
  // A tighter budget steps down rather than picking something that cannot be downloaded.
  assert.equal(pickMedia(payload('video'), 3_000_000)?.[0]?.url, 'https://video.twimg.com/amplify_video/1/vid/avc1/640x360/b.mp4');
  // An animated GIF also renders as a <video> on X, but this project publishes no animations, so it
  // must come back with no url and stay held instead of being transcoded into one.
  const gif = pickMedia(payload('animated_gif'), 20_000_000)?.[0];
  assert.equal(gif?.animated, true);
  assert.equal(gif?.url, undefined);
});

test('a video source is only accepted from X media hosts over https', () => {
  const withUrl = (url: string): unknown => ({ mediaDetails: [{ type: 'video',
    video_info: { duration_millis: 5_000, variants: [{ content_type: 'video/mp4', bitrate: 100_000, url }] } }] });
  for (const url of ['http://video.twimg.com/a.mp4', 'https://evil.example/a.mp4', 'file:///a.mp4', 'not a url']) {
    assert.equal(pickMedia(withUrl(url), 20_000_000)?.[0]?.url, undefined, url);
  }
  assert.equal(pickMedia(withUrl('https://video.twimg.com/amplify_video/1/vid/a.mp4'), 20_000_000)?.[0]?.url,
    'https://video.twimg.com/amplify_video/1/vid/a.mp4');
  // Anything that is not a video tweet yields nothing at all, so the caller holds it as before.
  for (const payload of [{ mediaDetails: [{ type: 'photo' }] }, { mediaDetails: [] }, {}, 'nonsense', null]) {
    assert.equal(pickMedia(payload, 20_000_000), undefined);
  }
  // An HLS-only tweet has no progressive rendition, so there is still nothing to download.
  assert.equal(pickMedia({ mediaDetails: [{ type: 'video', video_info: { duration_millis: 5_000,
    variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/1/pl/a.m3u8' }] } }] }, 20_000_000)?.[0]?.url, undefined);
});

test('a video tweet that also carries photos and more videos keeps every item, in order', () => {
  const clip = (n: number): Record<string, unknown> => ({ type: 'video', video_info: { duration_millis: 5_000,
    variants: [{ content_type: 'video/mp4', bitrate: 800_000, url: `https://video.twimg.com/amplify_video/${n}/vid/a.mp4` }] } });
  const media = pickMedia({ mediaDetails: [
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/A.jpg', ext_alt_text: 'first' },
    clip(1),
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/B.png' },
    { ...clip(2), ext_alt_text: 'clip alt' },
  ] }, 20_000_000);
  assert.deepEqual(media?.map(item => [item.kind, item.url, item.alt]), [
    ['image', 'https://pbs.twimg.com/media/A.jpg?name=orig', 'first'],
    ['video', 'https://video.twimg.com/amplify_video/1/vid/a.mp4', ''],
    ['image', 'https://pbs.twimg.com/media/B.png?name=orig', ''],
    ['video', 'https://video.twimg.com/amplify_video/2/vid/a.mp4', 'clip alt'],
  ]);
  // A photo it cannot fetch, or a kind it does not know, stays in place as `unknown` so the post is
  // held rather than published one item short.
  assert.deepEqual(pickMedia({ mediaDetails: [{ type: 'photo', media_url_https: 'https://evil.example/a.jpg' }, { type: 'model3d' }, clip(3)] }, 20_000_000)
    ?.map(item => item.kind), ['unknown', 'unknown', 'video']);
});

test('a not-yet-playing video or GIF poster is told apart from an attached photo', () => {
  for (const url of ['https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg', 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg?name=small',
    'https://pbs.twimg.com/tweet_video_thumb/AbC.jpg']) assert.equal(isVideoPoster(url), true, url);
  for (const url of ['https://pbs.twimg.com/media/AbC?format=jpg&name=small', 'https://evil.example/amplify_video_thumb/1.jpg']) assert.equal(isVideoPoster(url), false, url);
});

test('the syndication token stays on the formula the endpoint accepts', () => {
  // Anchored to a value the live endpoint answered 200 for; a drift here silently 404s every lookup.
  assert.equal(syndicationToken('1567257003890831360'), '3srola8enwm');
  assert.match(syndicationToken('20'), /^[0-9a-z]+$/);
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

test('a timeline self-thread continuation is parsed as a self-reply to the tweet above it', () => {
  const base = { authorId: 'owner', createdAt: '2026-09-19T00:00:00.000Z' };
  // The Posts timeline shows no "Replying to" header and embeds no parent status link for an
  // in-context continuation, so before the visual thread connector was read this parsed as a fresh
  // root (replyToId null) and synced as a separate, unthreaded post. threadParentId is the connector.
  const cont = parseTweetFacts({ ...base, id: '101', text: 'part 2', threadParentId: '100', threadParentAuthor: 'owner' }, 'owner');
  assert.equal(cont.replyToId, '100', 'continuation links to the tweet above it');
  assert.equal(cont.replyToAuthorId, 'owner', 'a self-thread reply is authored by the same account');
  assert.equal(cont.relationKnown, true, 'the parent is known outright, so the relationship is trusted');
  assert.equal(cont.metadataComplete, true);
  // The engine's self-reply test compares replyToAuthorId to authorId case-insensitively; they match.
  assert.equal(cont.replyToAuthorId?.toLowerCase(), cont.authorId.toLowerCase());
  // Without the connector (no reply markers at all) the same tweet is a root, exactly as before.
  const root = parseTweetFacts({ ...base, id: '100', text: 'part 1' }, 'owner');
  assert.equal(root.replyToId, null);
  assert.equal(root.replyToAuthorId, null);
  assert.equal(root.relationKnown, true);
});

test('a link into the quoted tweet (its /photo/1) does not make a quote look like a reply', () => {
  const quote = parseTweetFacts({ id: '200', authorId: 'owner', createdAt: '2026-09-19T00:00:00.000Z', text: 'look',
    quoteUrl: 'https://x.com/owner/status/100', statusLinks: ['https://x.com/owner/status/100', 'https://x.com/owner/status/100/photo/1'] }, 'owner');
  assert.equal(quote.replyToId, null);
  assert.equal(quote.quoteUrl, 'https://x.com/owner/status/100');
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
