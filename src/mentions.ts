import { cleanXLinks } from './text.js';
import type { Destination, SourcePost, TextMention } from './types.js';

export type MentionTargets = Partial<Record<Destination, string>>;
export interface MentionText { text: string; mentions: TextMention[] }

export function normalizeXHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('X ID 必須是 1–15 個英文字母、數字或底線，可加 @。');
  return handle.toLowerCase();
}

function validDomain(value: string): boolean {
  return value.length <= 253 && value.includes('.') && /^[a-z]/i.test(value.split('.').at(-1)!)
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function normalizeMentionTarget(destination: string, value: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (destination === 'bluesky') {
    if (!validDomain(handle)) throw new Error('Bluesky ID 請填完整 handle，例如 alice.bsky.social（不是顯示名稱或網址）。');
    return handle.toLowerCase();
  }
  if (destination === 'sharkey') {
    const [user, host, extra] = handle.split('@');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(user!) || extra !== undefined || (host !== undefined && !validDomain(host))) {
      throw new Error('Sharkey ID 請填 @alice 或 @alice@dvd.chat；省略網域表示發文實例的本地帳號。');
    }
    return host ? `${user}@${host.toLowerCase()}` : user!;
  }
  if (destination === 'telegram') {
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle)) throw new Error('Telegram ID 請填 5–32 字元的 @username（英文字母開頭），不是數字 user/chat ID。');
    return handle;
  }
  throw new Error('平台只能是 bluesky、sharkey 或 telegram。');
}

export function validTextMentions(text: string, mentions: TextMention[]): boolean {
  let end = 0;
  return mentions.every(mention => {
    const valid = Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end)
      && mention.start >= end && mention.end > mention.start && mention.end <= text.length
      && typeof mention.handle === 'string' && mention.handle.length > 0
      && text.slice(mention.start, mention.end).toLowerCase() === `@${mention.handle}`.toLowerCase();
    end = mention.end;
    return valid;
  });
}

/** Text rewrites must carry source offsets with them; repeated bare @text is not a second mention. */
export function mapMentionText(body: MentionText, transform: (text: string) => string): MentionText {
  let text = '', cursor = 0;
  const mentions: TextMention[] = [];
  for (const mention of body.mentions) {
    text += transform(body.text.slice(cursor, mention.start));
    const start = text.length;
    text += body.text.slice(mention.start, mention.end);
    mentions.push({ ...mention, start, end: text.length });
    cursor = mention.end;
  }
  return { text: text + transform(body.text.slice(cursor)), mentions };
}

export function renderXMentions(post: SourcePost, destination: Destination, mappings: Map<string, MentionTargets>): MentionText {
  if (post.platform !== 'x' || !post.mentions?.length) return { text: cleanXLinks(post.text), mentions: [] };
  if (!validTextMentions(post.text, post.mentions) || post.mentions.some(mention => !/^[A-Za-z0-9_]{1,15}$/.test(mention.handle))) {
    throw new Error('X mention offsets do not match the source text');
  }
  const body = mapMentionText({ text: post.text, mentions: post.mentions }, cleanXLinks);
  let text = '', cursor = 0;
  const mentions: TextMention[] = [];
  for (const mention of body.mentions) {
    text += body.text.slice(cursor, mention.start);
    const target = mappings.get(mention.handle.toLowerCase())?.[destination];
    if (target) {
      const handle = normalizeMentionTarget(destination, target);
      const start = text.length;
      text += `@${handle}`;
      mentions.push({ handle, start, end: text.length });
    } else {
      // A URL needs boundaries even when the original @mention touches CJK text or punctuation.
      if (text && !/\s$/u.test(text)) text += ' ';
      text += `https://x.com/${mention.handle}`;
      if (mention.end < body.text.length && !/^\s/u.test(body.text.slice(mention.end))) text += ' ';
    }
    cursor = mention.end;
  }
  return { text: text + body.text.slice(cursor), mentions };
}

export function sliceMentions(mentions: TextMention[], start: number, end: number): TextMention[] {
  return mentions.filter(mention => mention.start >= start && mention.end <= end)
    .map(mention => ({ ...mention, start: mention.start - start, end: mention.end - start }));
}
