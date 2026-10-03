import type { TextRange } from './types.js';

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const urlPattern = /https?:\/\/[^\s<>"'\u3000]+/giu;
const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com', 'fixupx.com', 'www.fixupx.com']);

export function fixupUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !xHosts.has(url.hostname.toLowerCase())) return;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/)
      || url.pathname.match(/^(\/i\/web\/status\/\d+)\/?$/);
    if (!match) return;
    const path = match.length === 2 ? match[1] : `/${match[1]}/status/${match[2]}`;
    return `https://fixupx.com${path}`;
  } catch { return; }
}

export function cleanXLinks(text: string): string {
  return text.replace(urlPattern, raw => {
    const punctuation = raw.match(/[.,!?;:，。！？；：)\]}]+$/u)?.[0] || '';
    const url = punctuation ? raw.slice(0, -punctuation.length) : raw;
    return (fixupUrl(url) || url) + punctuation;
  });
}

export function normalizeText(text: string): string {
  return cleanXLinks(text.normalize('NFC')).replace(/\s+/gu, ' ').trim();
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), s => s.segment);
}

export interface TextLimits { graphemes?: number; utf8Bytes?: number; utf16?: number }
export function fitsText(text: string, limits: TextLimits): boolean {
  return (limits.graphemes === undefined || graphemes(text).length <= limits.graphemes)
    && (limits.utf8Bytes === undefined || Buffer.byteLength(text, 'utf8') <= limits.utf8Bytes)
    && (limits.utf16 === undefined || text.length <= limits.utf16);
}

export function splitText(input: string, limits: TextLimits, protectedRanges: TextRange[] = []): string[] {
  if (Object.values(limits).some(v => !Number.isFinite(v) || v < 1)) throw new Error('Invalid text limit');
  if (protectedRanges.some(range => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > input.length)) throw new Error('Invalid protected text range');
  if (fitsText(input, limits)) return [input];
  const ranges = [...protectedRanges,
    ...Array.from(input.matchAll(urlPattern), match => ({ start: match.index, end: match.index + match[0].length }))]
    .sort((a, b) => a.start - b.start);
  const units: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    // An overlap means a range nested inside a wider one; the outer range already carries it whole.
    if (range.start < cursor) continue;
    units.push(...graphemes(input.slice(cursor, range.start)));
    const unit = input.slice(range.start, range.end);
    if (!fitsText(unit, limits)) throw new Error(`A ${/^https?:\/\//i.test(unit) ? 'URL' : 'mention'} exceeds the destination text limit; manual shortening is required`);
    units.push(unit);
    cursor = range.end;
  }
  units.push(...graphemes(input.slice(cursor)));
  const chunks: string[] = [];
  let chunk = '';
  for (const unit of units) {
    if (!fitsText(unit, limits)) throw new Error('A single grapheme exceeds the destination byte limit');
    if (!fitsText(chunk + unit, limits)) {
      chunks.push(chunk);
      chunk = unit;
    } else chunk += unit;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function htmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function similarity(a: string, b: string): number {
  const tokens = (value: string): Set<string> => {
    const chars = graphemes(normalizeText(value));
    if (chars.length < 3) return new Set(chars);
    return new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')));
  };
  const left = tokens(a), right = tokens(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  return [...left].filter(v => right.has(v)).length / union.size;
}

/** A video's or GIF's poster thumbnail on pbs.twimg.com, as opposed to an attached photo (/media/). */
export function isVideoPoster(url: string): boolean {
  return /^https:\/\/pbs\.twimg\.com\/(?:ext_tw_video|amplify_video|tweet_video)_thumb\//.test(url);
}
