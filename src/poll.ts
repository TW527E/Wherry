import { z } from 'zod';
import { PlatformError } from './platforms/parse.js';
import type { PollSnapshot, SourcePost } from './types.js';

export const pollSnapshotSchema = z.object({
  options: z.array(z.object({
    text: z.string().min(1).max(200).refine(text => Boolean(text.trim())),
    percentage: z.number().finite().min(0).max(100).optional(),
  })).min(2).max(4),
  status: z.enum(['open', 'closed', 'unknown']),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  expiresAtEstimated: z.boolean().optional(),
  totalVotes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  totalVotesText: z.string().min(1).max(120).optional(),
  statusText: z.string().min(1).max(120).optional(),
}).superRefine((poll, context) => {
  if (poll.expiresAtEstimated && !poll.expiresAt) context.addIssue({ code: 'custom', message: 'An estimated deadline requires expiresAt' });
  if (poll.expiresAt && poll.status === 'open' && (Date.parse(poll.expiresAt) <= Date.parse(poll.capturedAt)
    || Date.parse(poll.expiresAt) - Date.parse(poll.capturedAt) > 7 * 86400_000)) {
    context.addIssue({ code: 'custom', message: 'An open X poll must end within seven days of capture' });
  }
  const percentages = poll.options.flatMap(option => option.percentage === undefined ? [] : [option.percentage]);
  if (percentages.length && percentages.length !== poll.options.length) {
    context.addIssue({ code: 'custom', message: 'Poll results must cover every option' });
  }
  if (percentages.length === poll.options.length) {
    const sum = percentages.reduce((total, percentage) => total + percentage, 0);
    if (sum !== 0 && Math.abs(sum - 100) > poll.options.length * 0.5 + 0.01) {
      context.addIssue({ code: 'custom', message: 'Poll percentages are incomplete or inconsistent' });
    }
    if (poll.totalVotes === 0 && sum !== 0) context.addIssue({ code: 'custom', message: 'A zero-vote poll cannot have nonzero results' });
    if (sum === 0 && (poll.totalVotes ?? 0) > 0) context.addIssue({ code: 'custom', message: 'A poll with votes cannot have all-zero results' });
  }
});

export function xPollUrl(post: SourcePost): string | undefined {
  if (post.platform !== 'x' || !/^[A-Za-z0-9_]{1,15}$/.test(post.authorId) || !/^[1-9]\d{0,24}$/.test(post.id)) return;
  return `https://x.com/${post.authorId}/status/${post.id}`;
}

export function nativePollPayload(poll: PollSnapshot, destination: 'sharkey' | 'telegram', now = Date.now()): { choices: string[]; multiple: false; expiresAt: number } {
  const parsed = pollSnapshotSchema.safeParse(poll);
  if (!parsed.success) throw new PlatformError('Poll options or source metadata are incomplete', { code: 'InvalidPoll' });
  const source = parsed.data;
  if (source.status !== 'open') throw new PlatformError('The X poll is not confirmed open; it will not be reopened', { code: 'PollNotOpen' });
  if (!source.expiresAt) throw new PlatformError('The X poll deadline is unavailable; no duration will be invented', { code: 'PollDeadlineUnknown' });
  const expiresAt = Date.parse(source.expiresAt);
  if (!Number.isFinite(now) || Date.parse(source.capturedAt) > now + 60_000) throw new PlatformError('Poll capture clock is invalid', { code: 'InvalidPollClock' });
  if (expiresAt <= now) throw new PlatformError('The X poll expired before delivery; it will not be reopened', { code: 'PollExpired' });
  if (destination === 'telegram' && (Math.floor(expiresAt / 1000) - Math.ceil(now / 1000) < 5 || expiresAt - now > 2_628_000_000)) {
    throw new PlatformError('The remaining poll duration is outside Telegram limits', { code: 'PollDeadlineUnsupported' });
  }
  const choices = source.options.map(option => option.text);
  const limit = destination === 'sharkey' ? 50 : 100;
  if (choices.some(choice => Array.from(choice).length > limit) || new Set(choices).size !== choices.length) {
    throw new PlatformError(`${destination} poll choices must be distinct and no longer than ${limit} characters; choices will not be truncated`, { code: 'PollChoicesUnsupported' });
  }
  return { choices, multiple: false, expiresAt };
}

export function formatXPoll(poll: PollSnapshot, url: string): string {
  const snapshot = pollSnapshotSchema.parse(poll);
  const status = { open: '進行中', closed: '已結束', unknown: '狀態未提供' }[snapshot.status];
  const lines = [
    'Bluesky 不支援原生投票；請前往 X 參與。',
    `🗳️ X 投票（${status}；擷取時快照）`,
    ...snapshot.options.map((option, index) => `${index + 1}. ${option.text}${option.percentage === undefined ? '' : ` — ${option.percentage}%`}`),
  ];
  if (snapshot.totalVotes !== undefined) lines.push(`總票數：${snapshot.totalVotes}`);
  else if (snapshot.totalVotesText) lines.push(`票數顯示：${snapshot.totalVotesText}`);
  if (snapshot.statusText) lines.push(`原站狀態：${snapshot.statusText}`);
  if (snapshot.expiresAt) lines.push(`截止時間${snapshot.expiresAtEstimated ? '（依 X 倒數估算）' : ''}：${snapshot.expiresAt}`);
  if (snapshot.options.every(option => option.percentage === undefined)) lines.push('結果尚未顯示；不推算各選項票數。');
  lines.push(`擷取時間：${snapshot.capturedAt}`, '此處不接受投票，也不自動更新結果。', `前往 X 投票／查看最新結果：${url}`);
  return lines.join('\n');
}
