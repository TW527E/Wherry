import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { pollSnapshotSchema } from '../poll.js';
import type { PollOption, PollSnapshot } from '../types.js';

export const X_POLL_SELECTOR = '[data-testid="cardPoll"], [data-testid="pollResults"], [data-testid="pollPercentage"], [data-testid="pollTotalVotes"], [data-testid="pollTimeRemaining"], [role="radiogroup"], [role="group"] [role="radio"]';
const MAX_POLL_HTML_BYTES = 256_000;
const percentagePattern = /^(\d{1,3}(?:[.,]\d+)?)\s*[%％]$/u;
const countPattern = /^(\d+|\d{1,3}(?:,\d{3})+)\s*(?:votes?|票|票の投票)$/iu;
const votesPattern = /^(?:\d[\d.,\s]*[KMB萬万億亿]?\s*(?:votes?|票|票の投票)|\d[\d.,\s]*\s*人已投票)$/iu;
const closedPattern = /^(?:Final results|Poll ended|Voting ended|投票已結束|投票已结束|最終結果|最終結果已出爐|最終結果已出炉|最終結果出爐|最终结果|投票終了|投票は終了しました)$/iu;
const openPattern = /^(?:\d.+\sleft|剩餘.+|剩余.+|剩下.+|還剩.+|还有.+|あと.+|残り.+)$/iu;

function pollDeadline(statusText: string, capturedAt: string): string | undefined {
  const duration = statusText.normalize('NFKC').replace(/\sleft$|^(?:剩餘|剩余|剩下|還剩|还有|あと|残り)/giu, '').trim();
  const units: Record<string, number> = {
    day: 86400, days: 86400, d: 86400, 天: 86400, 日: 86400,
    hour: 3600, hours: 3600, h: 3600, 小時: 3600, 小时: 3600, 時間: 3600,
    minute: 60, minutes: 60, min: 60, mins: 60, m: 60, 分鐘: 60, 分钟: 60, 分: 60,
    second: 1, seconds: 1, sec: 1, secs: 1, s: 1, 秒: 1,
  };
  let seconds = 0;
  const rest = duration.replace(/(\d+)\s*(days?|hours?|minutes?|mins?|seconds?|secs?|[dhms]|小時|小时|時間|分鐘|分钟|天|日|分|秒)/giu,
    (_match, amount: string, unit: string) => { seconds += Number(amount) * units[unit.toLowerCase()]!; return ''; });
  if (!/^[\s,、]*$/u.test(rest) || seconds <= 0 || seconds > 7 * 86400 || !Number.isFinite(Date.parse(capturedAt))) return;
  // ponytail: X rounds its visible countdown; keep this estimate fixed across retries, use an exact DOM deadline if X exposes one later.
  return new Date(Date.parse(capturedAt) + seconds * 1000).toISOString();
}

export interface ParsedXPoll { detected: boolean; pollData?: PollSnapshot }

/** Parses only the rendered poll markup. It never fetches a result or casts a vote to reveal one. */
export function parseXPoll(html: string, capturedAt: string): ParsedXPoll {
  if (Buffer.byteLength(html, 'utf8') > MAX_POLL_HTML_BYTES) return { detected: true };
  const $ = load(html, {}, false);
  // A quoted poll belongs to the quoted author, not the enclosing tweet.
  $('[data-testid="quoteTweet"], article article, [data-testid="tweetText"], script, style, svg, [hidden], [aria-hidden="true"]').remove();
  $('img[alt]').each((_index, element) => { $(element).replaceWith($('<span>').text($(element).attr('alt') || '')); });
  const cards = $('[data-testid="cardPoll"]');
  const detected = cards.length > 0 || $(X_POLL_SELECTOR).length > 0;
  if (!detected) return { detected: false };
  if (cards.length > 1) return { detected: true };
  const scope = $('<div>').append(cards.length ? cards.clone() : $.root().contents());
  const radios = scope.find('[role="radio"]');
  const lists = scope.find('ul, [role="list"]').filter((_i, node) => $(node).parents('ul, [role="list"]').length === 0);
  const results = scope.find('[data-testid="pollResults"]');
  let choices: Cheerio<Element>;
  let resultRows = false;
  if (radios.length) choices = radios;
  else if (cards.length === 1 && lists.length === 1) {
    choices = lists.children('li, [role="listitem"]');
    resultRows = true;
  } else if (results.length === 1) {
    choices = results.find('li, [role="listitem"]');
    resultRows = true;
  } else return { detected: true };
  if (choices.length < 2 || choices.length > 4) return { detected: true };

  const text = (element: Cheerio<Element>): string => element.text().replace(/\s+/gu, ' ').trim();
  const options: PollOption[] = [];
  let invalid = false;
  choices.each((index, element) => {
    const row = $(element);
    const size = row.attr('aria-setsize');
    const position = row.attr('aria-posinset');
    if ((size !== undefined && Number(size) !== choices.length) || (position !== undefined && Number(position) !== index + 1)) invalid = true;
    const resultNodes = row.find('[data-testid="pollPercentage"]');
    // cardPoll result rows have separate dir containers for the choice and percentage. Do not
    // split concatenated text or read the CSS bar width: even 0% has a nonzero minimum bar width.
    const segments = row.find('[dir]').filter((_i, node) => $(node).find('[dir]').length === 0);
    let label: string;
    let percentage: number | undefined;
    if (resultNodes.length === 1) {
      const match = text(resultNodes).match(percentagePattern);
      if (!match) { invalid = true; return; }
      percentage = Number(match[1]!.replace(',', '.'));
      const clone = row.clone();
      clone.find('[data-testid="pollPercentage"]').remove();
      label = text(clone);
    } else if (resultNodes.length > 1) { invalid = true; return; }
    else if (resultRows) {
      if (segments.length !== 2) { invalid = true; return; }
      const match = text(segments.eq(1)).match(percentagePattern);
      if (!match) { invalid = true; return; }
      label = text(segments.eq(0));
      percentage = Number(match[1]!.replace(',', '.'));
    } else label = text(row) || (row.attr('aria-label') || '').trim();
    if (!label) { invalid = true; return; }
    options.push({ text: label, ...(percentage === undefined ? {} : { percentage }) });
  });
  if (invalid || options.length !== choices.length) return { detected: true };

  const meta = scope.clone();
  meta.find('ul, [role="list"], [role="radio"], [data-testid="pollResults"], [role="button"], button').remove();
  const tokens = meta.find('[data-testid="pollTotalVotes"], [data-testid="pollTimeRemaining"]')
    .add(meta.find('*').filter((_i, node) => $(node).children().length === 0))
    .map((_i, node) => text($(node))).get().flatMap(value => value.split(/\s*[·•]\s*/u)).map(value => value.trim()).filter(Boolean);
  const totalTexts = [...new Set(tokens.filter(value => votesPattern.test(value)))];
  const statusTexts = [...new Set(tokens.filter(value => closedPattern.test(value) || openPattern.test(value)))];
  const totalVotesText = totalTexts.length === 1 ? totalTexts[0] : undefined;
  const statusText = statusTexts.length === 1 ? statusTexts[0] : undefined;
  const exactCount = totalVotesText?.match(countPattern);
  const totalVotes = exactCount ? Number(exactCount[1]!.replaceAll(',', '')) : undefined;
  const status = statusText && closedPattern.test(statusText) ? 'closed'
    : statusText && openPattern.test(statusText) ? 'open' : radios.length && !radios.is('[aria-disabled="true"], [disabled]') ? 'open' : 'unknown';
  const expiresAt = status === 'open' && statusText ? pollDeadline(statusText, capturedAt) : undefined;
  const parsed = pollSnapshotSchema.safeParse({ options, status, capturedAt,
    ...(expiresAt ? { expiresAt, expiresAtEstimated: true } : {}),
    ...(totalVotesText ? { totalVotesText } : {}), ...(statusText ? { statusText } : {}),
    ...(totalVotes !== undefined && Number.isSafeInteger(totalVotes) ? { totalVotes } : {}) });
  return parsed.success ? { detected: true, pollData: parsed.data } : { detected: true };
}
