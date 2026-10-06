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
  baseline: '基準快照', collecting: '收集中', ready: '會同步', manual_mirror: '手動鏡像', mirror_review: '待確認', unsupported: '不支援', deleted: 'X 原文已刪除',
  // Reasons
  // No longer produced (GIFs now sync as video); kept so posts held under it before still read in zh-Hant.
  animated_video_not_supported: 'GIF 動畫不支援',
  branch_in_thread: '串文出現分支',
  collected_before_mixed_media: '升級前收集的圖片影片混合貼文，媒體可能不完整，請手動發布',
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
  more_than_four_images: '附件超過 4 個',
  multiple_possible_manual_mirrors: '有多則可能是手動鏡像',
  native_relationship_unknown: '無法判斷回覆關係',
  no_mirror_evidence: '新內容',
  non_public_content: '非公開內容',
  only_static_images_or_video: '只支援靜態圖片與影片',
  outbound_known: '本程式同步過去的貼文',
  outbound_possible: '疑似本程式同步的貼文（發送結果未確認）',
  owner_confirmed_new_content: '你已批准',
  owner_override: '你已手動處理',
  parent_author_unknown: '無法判斷回覆對象',
  poll_details_unavailable: '投票資料不完整',
  poll_not_supported: '此來源的投票不支援',
  poll_source_url_invalid: '投票原文連結無效',
  possible_manual_mirror: '疑似手動鏡像',
  reply_relationship_unknown: '無法判斷回覆關係',
  root: '串文第一則',
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
  // No longer produced (mixed media now syncs); kept so posts held under it before still read in zh-Hant.
  video_must_be_the_only_attachment: '影片不能與其他附件混用',
  video_poster_repaired: '原本把影片封面誤判成圖片，已修正，可以發布',
  video_sync_disabled: '影片同步未啟用',
  x_post_deleted: 'X 原文已刪除，其他平台的副本也會刪除',
  x_video_has_no_downloadable_source: '影片沒有可下載的來源',
};

/** "中文說明（code）" for plain-text channels, keeping the code greppable in logs and docs. */
export function describe(code: string | undefined): string {
  if (!code) return '';
  const label = LABELS[code];
  return label ? `${label}（${code}）` : code;
}

export const PLATFORM_NAMES: Record<string, string> = { x: 'X', bluesky: 'Bluesky', sharkey: 'Sharkey', telegram: 'Telegram', local: '本地排程' };
const P = (platform: string): string => PLATFORM_NAMES[platform] ?? platform;
const L = (code: string): string => LABELS[code] ?? code;
const ACTIONS: Record<string, string> = { approve: '批准發布', skip: '略過', mirror: '標記為手動鏡像' };

/**
 * The event log is written in English for greppable logs; these patterns turn the messages the code
 * emits into zh-Hant for the Web UI. Order matters: the generic `platform: error` pattern is last.
 * A message nothing matches returns undefined, and the UI shows it raw behind a disclosure.
 */
const EVENTS: Array<[RegExp, (...m: string[]) => string]> = [
  [/^\[preview\] (\w+) (part|footer): ([\s\S]*)$/, (d, k, t) => `預覽：本來會發到 ${P(d)} 的${k === 'footer' ? '頁尾' : '內容'}：${t}`],
  [/^(\w+): (\d+) new records from (\d+) collected( \(baseline only\))?; newest=\S+ baseline=\S+(?: — ([\s\S]*))?$/,
    (p, added, seen, base, warn) => `${P(p)}：讀到 ${seen} 則，${base ? '首次掃描，只建立基準' : added === '0' ? '沒有新貼文' : `新增 ${added} 則`}${warn ? `；警告：${warn}` : ''}`],
  [/^(\w+): delivered (\d+) parts$/, (d, n) => `${P(d)}：已送出 ${n} 則`],
  [/^\[preview\] (\w+) delete: /, d => `預覽：本來會刪除 ${P(d)} 上的副本`],
  [/^X post (\d+) was deleted; removing its copies from (.+)$/, (id, list) => `X 原文 ${id} 已刪除，${list.startsWith('nowhere') ? '還沒同步出去，不會再發' : `正在刪除 ${list.split(', ').map(P).join('、')} 上的副本`}`],
  [/^(\w+): removed the copies of a post deleted on X$/, d => `${P(d)}：已刪除 X 原文已刪的副本`],
  [/^(\w+): could not remove a copy of a post deleted on X: ([\s\S]*)$/, (d, e) => `${P(d)}：X 原文已刪，但副本刪不掉（Telegram 超過 48 小時只能手動刪）：${e}`],
  [/^X deletion check skipped/, () => '這次沒檢查 X 原文是否被刪：嵌入端點連一則確定存在的貼文都查不到'],
  [/^(\w+) collection failed: ([\s\S]*)$/, (p, e) => `讀取 ${P(p)} 失敗：${e}`],
  [/^Service started in (\w+) mode on \S+$/, m => `服務已啟動（${m === 'live' ? '正式模式' : '預覽模式'}）`],
  [/^Service cycle failed: ([\s\S]*)$/, e => `定期檢查失敗：${e}`],
  [/^Startup cycle failed: ([\s\S]*)$/, e => `啟動後第一次檢查失敗：${e}`],
  [/^Background task failed: ([\s\S]*)$/, e => `背景工作失敗：${e}`],
  [/^Telegram update handling failed: ([\s\S]*)$/, e => `處理 Telegram 訊息失敗：${e}`],
  [/^Telegram command polling failed: ([\s\S]*)$/, e => `讀取 Telegram 指令失敗：${e}`],
  [/^Telegram command failed: ([\s\S]*)$/, e => `Telegram 指令執行失敗：${e}`],
  [/^Telegram setMyCommands failed: ([\s\S]*)$/, e => `設定 Telegram 指令選單失敗：${e}`],
  [/^Telegram reminder update failed; saved choice will be retried: ([\s\S]*)$/, e => `更新 Telegram 提醒失敗，會再重試：${e}`],
  [/^Telegram review notice update failed; will retry: ([\s\S]*)$/, e => `更新 Telegram 待決通知失敗，會再重試：${e}`],
  [/^Could not delete uploaded session message: ([\s\S]*)$/, e => `無法刪除你上傳的 session 訊息：${e}`],
  [/^X session uploaded via Telegram for @(\S*); authenticated=(\w+); messageDeleted=(\w+)$/,
    (h, ok, del) => `已透過 Telegram 安裝 @${h} 的 X session，${ok === 'true' ? '驗證成功' : '但驗證沒通過'}${del === 'true' ? '' : '（上傳的訊息沒刪掉，請手動刪除）'}`],
  [/^X session upload failed: ([\s\S]*)$/, e => `X session 上傳失敗：${e}`],
  [/^Native post held: (\w+)$/, r => `貼文暫停同步：${L(r)}`],
  [/^(\w+) post (\S+) is held for your decision \((\w+)\)/, (p, id, r) => `${P(p)} 貼文 ${id} 等你決定（${L(r)}），處理前不會同步`],
  [/^X self-reply (\S+) continues (\S+), which was never collected/, (id, parent) => `X 自回覆 ${id} 接在沒讀到的貼文 ${parent} 後面，不會同步（可調高 X_MAX_PAGES 或更常檢查）`],
  [/^X self-reply (\S+) came (\d+)s after its thread window closed \(THREAD_WINDOW_SECONDS=(\d+)\)/,
    (id, late, win) => `X 自回覆 ${id} 比串文窗口晚了 ${late} 秒（窗口 ${win} 秒），這則和之後的串文都不會同步`],
  [/^X self-reply (\S+) could not join batch (\S+) \(state (\w+)\)/, (id, b, s) => `X 自回覆 ${id} 無法加入批次 ${b}（${L(s)}），不會同步`],
  [/^Sealing (\S+) with stale downstream mirror data \((.+) unreachable\)/, (b, list) => `批次 ${b} 已封存，但 ${list.split(', ').map(P).join('、')} 連不上，手動鏡像判斷可能不完整`],
  [/^X batch held: (\w+)$/, r => `X 批次暫停：${L(r)}`],
  [/^X batch confirmed as manual mirror of (\d+) downstream/, n => `X 批次已確認是 ${n} 則下游貼文的手動鏡像，不會反向同步`],
  [/^Manual mirror registered after delivery started/, () => '發送開始後才登記手動鏡像；請檢查其他平台的貼文，程式不會自動刪除'],
  [/^Manual X mirror registered/, () => '已登記 X 手動鏡像，待發送的回傳已取消'],
  [/^Owner cancelled a job/, () => '你放棄了一個工作，不會再發送或重試'],
  [/^Owner reconciled an unknown delivery/, () => '你確認了結果不明的發送，未確認的部分會重新發送'],
  [/^Owner action: (\w+)$/, a => `你的操作：${ACTIONS[a] ?? a}`],
  [/^No publisher configured for (\w+)$/, d => `${P(d)} 沒有設定發布器`],
  [/^Dropped (\d+) baseline history posts/, n => `清掉 ${n} 則誤登記為手動鏡像的舊貼文`],
  [/^(x|bluesky|sharkey|telegram): ([\s\S]*)$/, (d, e) => `${P(d)} 發送失敗：${e}`],
];

export function readableEvent(message: string): string | undefined {
  for (const [pattern, format] of EVENTS) {
    const match = pattern.exec(message);
    if (match) return format(...match.slice(1).map(v => v ?? ''));
  }
  return undefined;
}
