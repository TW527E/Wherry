import type { SensitiveLabel, SourcePost } from './types.js';

export const BLUESKY_SENSITIVE_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media'] as const satisfies readonly SensitiveLabel[];
export const DEFAULT_BLUESKY_SENSITIVE_LABEL: SensitiveLabel = 'graphic-media';
export const DEFAULT_CONTENT_WARNING = '來源標記為敏感內容';

type Marking = Pick<SourcePost, 'sensitive' | 'cw' | 'sensitiveLabels'>;

export function isSensitiveContent(part: Marking): boolean {
  // Sharkey's empty CW still folds the post, unlike an absent CW.
  return part.sensitive === true || part.cw !== undefined || Boolean(part.sensitiveLabels?.length);
}

export function contentWarning(part: Marking): string | undefined {
  return part.cw?.trim() ? part.cw : isSensitiveContent(part) ? DEFAULT_CONTENT_WARNING : undefined;
}

export function warningPrefix(part: Marking): string {
  const warning = contentWarning(part);
  return warning === undefined ? '' : `CW: ${warning}\n\n`;
}
