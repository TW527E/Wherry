/**
 * zh-Hant labels for the state, classification and reason codes the store records. Shared by the web
 * UI (shipped to the page as JSON) and the Telegram replies, so the owner never has to decode
 * `long_x_post_requires_manual_review`. An unknown code falls back to itself.
 */
export const LABELS: Record<string, string> = {
  // Batch and job states
  open: '收集串文中', sealed: '已封存', review: '等你決定', mirror: '手動鏡像', ignored: '不同步',
  pending: '等待發送', running: '發送中', succeeded: '已送達', failed: '失敗', unknown: '結果不明', cancelled: '已取消',
  // Post classifications
  baseline: '基準快照', collecting: '收集中', ready: '會同步', manual_mirror: '手動鏡像', mirror_review: '待確認', unsupported: '不支援',
  // Reasons
  animated_video_not_supported: 'GIF 動畫不支援',
  branch_in_thread: '串文出現分支',
  collecting_initial_thread: '串文窗口內，等待自回覆',
  empty_content: '沒有內容',
  first_snapshot_no_backfill: '首次掃描前的舊貼文，不回填',
  ignored_native_non_root_or_private: '回覆或非公開貼文',
  incomplete_metadata: '貼文資料不完整',
  initial_self_thread: '新串文',
  local_schedule: '本地排程',
  local_scheduled: '本地排程',
  long_x_post_requires_manual_review: '長文，確認後會自動分段發布',
  manual_mirror_registered: '已登記手動鏡像',
  manual_x_reminder: '已提醒你手動發到 X',
  more_than_four_images: '超過 4 張圖片',
  multiple_possible_manual_mirrors: '有多則可能是手動鏡像',
  native_relationship_unknown: '無法判斷回覆關係',
  no_mirror_evidence: '新內容',
  non_public_content: '非公開內容',
  only_static_images_or_video: '只支援靜態圖片或單一影片',
  owner_confirmed_new_content: '你已批准',
  owner_override: '你已手動處理',
  parent_author_unknown: '無法判斷回覆對象',
  poll_details_unavailable: '投票資料不完整',
  poll_not_supported: '此來源的投票不支援',
  poll_source_url_invalid: '投票原文連結無效',
  possible_manual_mirror: '疑似手動鏡像',
  reply_relationship_unknown: '無法判斷回覆關係',
  reply_to_other: '回覆他人',
  repost_or_non_public: '轉貼或非公開',
  scheduled_no_x_url_yet: '本地排程',
  self_reply_outside_new_batch: '回覆舊串文',
  skipped_late_self_reply: '晚發的自回覆（超過串文窗口）',
  source_clock_invalid: '來源時間異常',
  thread_closed: '串文已收齊',
  thread_is_not_linear: '串文有分支，不自動攤平',
  unique_text_and_media_match: '與你的下游貼文相同',
  video_exceeds_duration_limit: '影片超過 140 秒',
  video_must_be_the_only_attachment: '影片不能與其他附件混用',
  video_sync_disabled: '影片同步未啟用',
  x_video_has_no_downloadable_source: '影片沒有可下載的來源',
};

/** "中文說明（code）" for plain-text channels, keeping the code greppable in logs and docs. */
export function describe(code: string | undefined): string {
  if (!code) return '';
  const label = LABELS[code];
  return label ? `${label}（${code}）` : code;
}
