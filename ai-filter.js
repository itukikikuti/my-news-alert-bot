import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadHistory } from "./lib.js";

// AI notification filtering.
// Filtering is opt-in per feed: the model runs only when the feed has a prompt.
//   - feed prompt empty  -> no API call, every new article is notified
//   - feed prompt set    -> the feed rule decides, with the recent-notified
//                           headline list attached (same-event duplicates -> NO)
// The iris judge (mode "iris", the deployed default) is authoritative; the
// gpt-oss path stays available for "gpt-oss"/"hybrid" but hybrid ORs the two
// verdicts, which lets a gpt-oss fail-open YES override a duplicate NO.
// Set OLLAMA_API_KEY to enable gpt-oss. When unset or on any failure, the
// article is notified (fail-open) so filtering never silently drops everything.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "https://ollama.com";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";
const REQUEST_TIMEOUT_MS = 60000;

// How much article body to include in the prompt (keeps requests small).
const BODY_EXCERPT_CHARS = 1200;

function getApiKey() {
  return process.env.OLLAMA_API_KEY || "";
}

export function isAiFilterEnabled() {
  return Boolean(getApiKey());
}

function buildPrompt({ title, body, feedPrompt, recentHeadlines = [] }) {
  const articleBody = body
    ? body.slice(0, BODY_EXCERPT_CHARS)
    : "(本文を取得できませんでした)";

  return `あなたはニュース通知ボットの判定AIです。以下の新着記事を通知すべきか判定してください。

# このフィードの通知ルール
${feedPrompt.trim()}

${buildRecentHeadlinesSection(recentHeadlines)}

# 判定対象の新着記事
タイトル: ${title}
本文: ${articleBody}

# 判定基準
1. 上の「通知ルール」に沿っているか。ルールが除外を指示している内容なら通知しない。
2. 「直近に通知した記事」と同じ出来事（同じ公演・イベント・ニュースの別媒体の記事、X/ソーシャル投稿、実質同じ内容の続報）なら、新しい事実が明確に加わっていない限り通知しない。
3. 判断に迷う場合は、通知する側に倒す。ただし重複の判断（2）が優先です。

# 出力形式
必ず次の形式の1行だけを出力してください。余計な説明は書かないこと。
NOTIFY: <YESまたはNO> | REASON: <20文字以内の理由>`;
}

function parseDecision(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/NOTIFY\s*[:：]\s*(YES|NO)/i);
  if (!match) return null;
  const notify = match[1].toUpperCase() === "YES";
  const reasonMatch = raw.match(/REASON\s*[:：]\s*(.+)/i);
  const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 100) : "";
  return { notify, reason };
}

// Best-effort extraction of model text from an Ollama Cloud chat response.
// Reasoning models (e.g. gpt-oss) may return the answer in `content` after
// spending tokens in `thinking`; a too-small num_predict leaves content empty.
function extractContent(json) {
  return (
    json?.message?.content ??
    json?.choices?.[0]?.message?.content ??
    json?.response ??
    ""
  );
}

/**
 * Decide whether to notify for one article.
 * The model is consulted only when the feed has a non-empty prompt.
 * @param {{ title: string, body?: string, feedPrompt?: string }} params
 * @returns {Promise<{ notify: boolean, reason?: string, skipped?: boolean, error?: string }>}
 */
export async function shouldNotify({ title, body, feedPrompt, entryKey }) {
  if (!feedPrompt?.trim()) {
    return { notify: true, skipped: true, reason: "No feed prompt; notifying" };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return { notify: true, skipped: true, reason: "AI filter disabled (no API key)" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const recentHeadlines = await loadRecentNotifiedHeadlines({ excludeKey: entryKey });
    const prompt = buildPrompt({ title, body, feedPrompt, recentHeadlines });

    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0, num_predict: 512 },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const rawReply = extractContent(json);
    const decision = parseDecision(rawReply);
    if (!decision) {
      // Unparseable answer: fail open (notify) but surface the reason.
      console.warn("[AI] Unparseable decision, notifying anyway:", rawReply.slice(0, 120));
      return { notify: true, reason: "AI応答を解釈できず通知", rawReply };
    }
    return { ...decision, rawReply };
  } catch (e) {
    console.warn(`[AI] Filter failed, notifying anyway: ${e.message}`);
    return { notify: true, error: e.message, reason: "AI判定失敗のため通知" };
  } finally {
    clearTimeout(timeout);
  }
}
// ---------------------------------------------------------------------------
// iris: every judgment goes to ONE fixed iris work session ("通知判定").
//   - The session id lives in <data>/iris-session.json and survives restarts.
//   - A new session is created only when the saved one is gone (404) or broken
//     (several judgment turns in a row ended in an error). Creation is rate
//     limited so an outage cannot flood the iris session list again.
//   - Each message carries a few lines of rules plus only the title and URL of
//     up to IRIS_BATCH_SIZE articles (no body, no headline list). The judge
//     must not open the URLs itself: it starts one subagent (Agent tool) per
//     article, which reads the page and reports back in two lines.
//   - Duplicate suppression relies on the session itself: it remembers the
//     events it answered YES to. "/compact" is told to keep that YES list, but
//     a replaced session starts with no memory.
//   - Each message carries a unique request id (articles: "<id>-1", "<id>-2",
//     ...); the reply is accepted only from the turn whose input contains
//     that id and only if the answer line repeats the id. A late reply to an
//     earlier article can therefore never be taken for the current one.
//   - <data>/iris-judge.lock serialises judges across processes (cron, manual
//     runs), so two messages are never in flight in the session at once.
//   - When iris is busy/unreachable the article is deferred (left unseen and
//     retried next run) instead of being guessed; after IRIS_MAX_DEFERRALS
//     retries it falls back to the old fail-open behaviour (notify).
// The model is iris' work-session default; IRIS_MODEL_ID (unset by default)
// only applies when a new judge session has to be created.
// ---------------------------------------------------------------------------

const IRIS_BASE_URL = (process.env.IRIS_URL || "http://10.0.0.99:3170").replace(/\/$/, "");
const IRIS_SESSION_TITLE = "通知判定";
const DATA_DIR = path.dirname(process.env.STATE_FILE || "/data/state.json");
const IRIS_SESSION_FILE = process.env.IRIS_SESSION_FILE || path.join(DATA_DIR, "iris-session.json");
const IRIS_LOCK_FILE = process.env.IRIS_LOCK_FILE || path.join(DATA_DIR, "iris-judge.lock");
const IRIS_DEFER_FILE = process.env.IRIS_DEFER_FILE || path.join(DATA_DIR, "iris-deferrals.json");
const envMs = (name, fallback) => Number(process.env[name]) || fallback;
const IRIS_HTTP_TIMEOUT_MS = envMs("IRIS_HTTP_TIMEOUT_MS", 30000);
// One message (subagents opening the articles in parallel) normally takes
// 20-60 s; an automatic compaction inside the turn can take minutes.
const IRIS_REPLY_TIMEOUT_MS = envMs("IRIS_REPLY_TIMEOUT_MS", 240000);
const IRIS_IDLE_WAIT_MS = envMs("IRIS_IDLE_WAIT_MS", 90000);
const IRIS_LOCK_WAIT_MS = envMs("IRIS_LOCK_WAIT_MS", 90000);
const IRIS_LOCK_STALE_MS = 15 * 60000;
// A turn running longer than this is considered hung and is stopped.
const IRIS_STUCK_TURN_MS = envMs("IRIS_STUCK_TURN_MS", 15 * 60000);
const IRIS_POLL_MS = envMs("IRIS_POLL_MS", 1000);
const IRIS_MAX_CONSECUTIVE_ERRORS = 3;
const IRIS_MIN_RECREATE_INTERVAL_MS = envMs("IRIS_MIN_RECREATE_INTERVAL_MS", 60 * 60000);
const IRIS_MAX_DEFERRALS = 5;
// The whole conversation is re-sent on every model call, so cost grows with
// every judgment. Once a call's context passes this many tokens, the session is
// compacted (same session, "/compact") with instructions that keep only the
// standing rules — no past articles or verdicts that could bias later ones.
// Claude Code would otherwise auto-compact only near ~170k tokens, with a
// generic summary that keeps earlier articles. 0 disables.
const IRIS_COMPACT_AT_TOKENS = Number(process.env.IRIS_COMPACT_AT_TOKENS ?? 60000);

// Duplicate suppression for the gpt-oss judge: its prompt carries the headlines
// already notified (from history.json plus the articles notified earlier in this
// same run). The iris judge gets no such list; it remembers its own YES answers.
const IRIS_RECENT_HEADLINES = envMs("IRIS_RECENT_HEADLINES", 40);
const IRIS_RECENT_WINDOW_MS = envMs("IRIS_RECENT_WINDOW_MS", 7 * 24 * 60 * 60 * 1000);

// Headlines notified earlier in the current process. index.js judges a whole
// feed before it sends anything, so history.json alone would miss same-run twins.
const notifiedThisRun = [];

export function rememberNotifiedThisRun({ title, link }) {
  if (!title) return;
  notifiedThisRun.unshift({ title: String(title), link: link || "", sentAt: new Date().toISOString() });
  if (notifiedThisRun.length > IRIS_RECENT_HEADLINES) notifiedThisRun.length = IRIS_RECENT_HEADLINES;
}

const headlineKey = (title) => String(title || "").replace(/[\s　]+/g, "").slice(0, 80);

const formatHeadlineTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
};

/** Recently notified headlines, newest first, de-duplicated by title. */
export async function loadRecentNotifiedHeadlines({ limit = IRIS_RECENT_HEADLINES, excludeKey } = {}) {
  const history = await loadHistory().catch(() => []);
  const cutoff = Date.now() - IRIS_RECENT_WINDOW_MS;
  const seen = new Set();
  const rows = [];
  const add = (entry) => {
    if (rows.length >= limit) return;
    const title = String(entry?.title || "").replace(/\s+/g, " ").trim();
    if (!title) return;
    const key = headlineKey(title);
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push({ title: title.slice(0, 160), sentAt: entry.sentAt || "", link: entry.link || "" });
  };
  // The current run's YES articles are the newest of all.
  for (const entry of notifiedThisRun) add(entry);
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry?.notified) continue;
    if (excludeKey && entry.entryKey === excludeKey) continue;
    const sent = Date.parse(entry.sentAt || "");
    if (Number.isFinite(sent) && sent < cutoff) continue;
    add(entry);
  }
  return rows;
}

function buildRecentHeadlinesSection(recentHeadlines) {
  if (!recentHeadlines?.length) {
    return `# 直近に通知した記事
(まだありません)`;
  }
  const lines = recentHeadlines
    .map((h, i) => {
      const time = formatHeadlineTime(h.sentAt);
      return `${i + 1}. ${h.title}${time ? `（${time}）` : ""}`;
    })
    .join("\n");
  return `# 直近に通知した記事（重複通知を避けるための参考）
下は最近すでに通知した見出しです。今回の記事がこれらと同じ出来事（同じ公演・イベント・ニュースについての別媒体の記事、X/ソーシャル投稿、実質同じ内容の続報）を扱っているなら、通知しないでください。
${lines}`;
}

const IRIS_SETUP_MESSAGE = `あなたはニュース通知ボットの判定専用セッションです。これから「通知判定」が届きます（1通に記事1〜数件、タイトルとURLだけ）。
- 記事は自分で開かず、サブエージェント（Agent ツール）にURLを開かせて確認してください。
- 重複を避けるため、このセッションで YES にした記事の出来事を覚えておき、同じ出来事の記事は NO にしてください。
- 回答は記事IDごとに1行（YES/NO と短い理由）を submit_result（kind: done）で出してください。
いまは準備の確認です。submit_result（kind: done）で「READY」とだけ出してください。`;

// Kept by "/compact": the YES list is what duplicate suppression relies on.
const IRIS_COMPACT_INSTRUCTIONS = "要約には次のことだけを残してください: (1) このセッションはニュース通知ボットの判定専用で、記事はサブエージェント（Agent ツール）にURLを開かせて確認し、回答は記事IDごとに1行（YES/NO と短い理由）を submit_result（kind: done）で出すこと。(2) これまでに YES にした記事の一覧を必ず全件残すこと（1件1行: 出来事（何・いつ・どこ）/ 判定日 / タイトル）。同じ出来事の記事を以後 NO にするために使います。NO にした記事・ツールの失敗例・その他のやり取りは要約に含めないでください。";

// Articles per judgment message; the subagents of one message run in parallel.
const IRIS_BATCH_SIZE = Math.min(Math.max(envMs("IRIS_BATCH_SIZE", 5), 1), 9);

export function getFilterMode() {
  const mode = (process.env.AI_FILTER_MODE || "hybrid").toLowerCase();
  return ["gpt-oss", "iris", "hybrid"].includes(mode) ? mode : "hybrid";
}

/** iris is busy, unreachable or did not answer in time: retry the article next run. */
class IrisDefer extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function irisHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (process.env.IRIS_TOKEN) headers["x-iris-token"] = process.env.IRIS_TOKEN;
  return headers;
}

async function irisFetch(pathname, init = {}) {
  try {
    return await fetch(`${IRIS_BASE_URL}${pathname}`, {
      ...init,
      headers: irisHeaders(),
      signal: AbortSignal.timeout(IRIS_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IrisDefer(`iris unreachable: ${error.name === "TimeoutError" ? "timeout" : error.message}`);
  }
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

const readPointer = () => readJsonFile(IRIS_SESSION_FILE, null);
const savePointer = (pointer) => writeJsonFile(IRIS_SESSION_FILE, pointer);

// ---- cross-process lock -----------------------------------------------------

const LOCK_OWNER = `${os.hostname()}:${process.pid}`;

async function lockIsStale() {
  try {
    const stat = await fs.stat(IRIS_LOCK_FILE);
    if (Date.now() - stat.mtimeMs > IRIS_LOCK_STALE_MS) return true;
    const owner = String((await readJsonFile(IRIS_LOCK_FILE, {})).owner || "");
    const [host, pid] = owner.split(":");
    if (host !== os.hostname() || !Number(pid)) return false;
    try {
      process.kill(Number(pid), 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function acquireLock() {
  const deadline = Date.now() + IRIS_LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(path.dirname(IRIS_LOCK_FILE), { recursive: true });
      const handle = await fs.open(IRIS_LOCK_FILE, "wx");
      await handle.writeFile(JSON.stringify({ owner: LOCK_OWNER, at: new Date().toISOString() }));
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (await lockIsStale()) {
      console.warn("[IRIS] Removing stale judge lock");
      await fs.rm(IRIS_LOCK_FILE, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new IrisDefer("another judgment is still running (lock busy)");
    await sleep(1000);
  }
}

async function releaseLock() {
  const lock = await readJsonFile(IRIS_LOCK_FILE, null);
  if (lock?.owner === LOCK_OWNER) await fs.rm(IRIS_LOCK_FILE, { force: true });
}

// ---- deferral bookkeeping ----------------------------------------------------

async function bumpDeferral(key) {
  const counts = await readJsonFile(IRIS_DEFER_FILE, {});
  const count = (counts[key] || 0) + 1;
  delete counts[key];
  counts[key] = count;
  const keys = Object.keys(counts);
  for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete counts[old];
  await writeJsonFile(IRIS_DEFER_FILE, counts);
  return count;
}

async function clearDeferral(key) {
  const counts = await readJsonFile(IRIS_DEFER_FILE, {});
  if (!(key in counts)) return;
  delete counts[key];
  await writeJsonFile(IRIS_DEFER_FILE, counts);
}

// ---- iris session access -----------------------------------------------------

/** Session meta plus the turns from `fromTurn` on; null when the session does not exist. */
async function getSessionView(id, fromTurn = 1e9) {
  const response = await irisFetch(`/api/sessions/${encodeURIComponent(id)}/transcript?from=${fromTurn}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new IrisDefer(`iris transcript HTTP ${response.status}`);
  return response.json();
}

const turnFinished = (session, turn) =>
  session.turns > turn || (session.turns === turn && session.status !== "running");

/**
 * Texts the model produced in one turn: plain replies first, then submit_result
 * bodies, so a submitted answer line wins over chatter such as "提出しました（ID: NO）".
 */
function answerTexts(turn) {
  const texts = [];
  const submitted = [];
  for (const event of turn?.events || []) {
    if (event.type !== "assistant" || event.parent_tool_use_id) continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && /submit_result$/.test(block.name || "") && typeof block.input?.body === "string") {
        submitted.push(block.input.body);
      } else if (block?.type === "text" && block.text?.trim()) {
        texts.push(block.text);
      }
    }
  }
  return [...texts, ...submitted];
}

const usageTokens = (usage) =>
  (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);

/** Largest single model call of the turn (= current conversation size), error flag, compaction info, subagent use. */
function turnUsage(turn) {
  const events = turn?.events || [];
  const result = [...events].reverse().find((event) => event.type === "result");
  const perCall = events
    .filter((event) => event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage)
    .map((event) => usageTokens(event.message.usage));
  const boundary = events.find((event) => event.type === "system" && event.subtype === "compact_boundary");
  const mainTools = events
    .filter((event) => event.type === "assistant" && !event.parent_tool_use_id)
    .flatMap((event) => (Array.isArray(event.message?.content) ? event.message.content : []))
    .filter((block) => block?.type === "tool_use")
    .map((block) => block.name || "");
  return {
    isError: Boolean(result?.is_error),
    contextTokens: perCall.length ? Math.max(...perCall) : usageTokens(result?.usage),
    calls: perCall.length,
    compacted: boundary ? boundary.compact_metadata || {} : null,
    subagents: mainTools.filter((name) => name === "Agent" || name === "Task").length,
    selfFetches: mainTools.filter((name) => name === "WebFetch" || name === "Bash").length,
  };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find "<requestId>: YES|NO ..." in the turn's answers (last one wins). */
export function parseIrisDecision(texts, requestId) {
  // (?!\d) keeps "REQ-…-1" from matching the answer for "REQ-…-10".
  const pattern = new RegExp(`${escapeRegExp(requestId)}(?!\\d)\\s*[\\]】)]?\\s*[:：]?\\s*\\**\\s*(YES|NO)\\b(.*)`, "i");
  for (const text of [...texts].reverse()) {
    const lines = String(text).split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) {
        const reason = match[2].replace(/^[\s|｜:：\-—*]+/, "").trim().slice(0, 100);
        return { notify: match[1].toUpperCase() === "YES", reason: `iris=${match[1].toUpperCase()}${reason ? ` ${reason}` : ""}`, line: line.trim() };
      }
    }
  }
  return null;
}

function newRequestId() {
  return `REQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// ---- subagent model ------------------------------------------------------------
// The judge never opens articles itself; a subagent (Agent tool) does. On a
// Claude session the subagent runs on haiku. On an Ollama session "haiku" does
// not exist (the Agent call fails with model_not_found), so no model is named
// and the subagent inherits the session's (already light) Ollama model.
// IRIS_SUBAGENT_MODEL forces a value; "inherit" means "do not name a model".

let modelKindsCache = null;

async function sessionModelKind(modelId) {
  if (!modelId) return "";
  if (!modelKindsCache) {
    modelKindsCache = new Map();
    try {
      const response = await irisFetch("/api/settings");
      if (response.ok) {
        const settings = await response.json();
        for (const model of settings?.models || []) modelKindsCache.set(model.id, model.kind);
      }
    } catch {
      // Unknown kind: fall back to inheriting the session model.
    }
  }
  return modelKindsCache.get(modelId) || "";
}

export async function subagentModelFor(modelId) {
  const forced = (process.env.IRIS_SUBAGENT_MODEL || "").trim();
  if (forced) return forced === "inherit" ? "" : forced;
  return (await sessionModelKind(modelId)) === "claude" ? "haiku" : "";
}

/** Article ids inside one message: "<requestId>-1", "<requestId>-2", ... */
export const articleId = (requestId, index) => `${requestId}-${index + 1}`;

function buildIrisMessageWith({ requestId, articles, feedPrompt, subagentModel }) {
  const many = articles.length > 1;
  const rule = feedPrompt.trim().replace(/\s+/g, " ");
  const modelArg = subagentModel ? `, model: "${subagentModel}"` : "、model は指定しない";
  const list = articles
    .map((article, index) => `[${articleId(requestId, index)}] ${article.title}\n${article.link || "(URLなし)"}`)
    .join("\n");
  return `【通知判定 ${requestId}】
ルール: ${rule}
- 記事は自分で開かず、URLごとに Agent ツール（subagent_type: "general-purpose", run_in_background: false${modelArg}）で確認させる${many ? "（全件まとめて並列に）" : ""}。依頼文:「<URL> を開き（WebFetch不可ならcurl）、2行で返す。submit_resultは使わない。1) ルール『${rule}』に当たる本人の新情報（出演・参加・発言など）か はい/いいえ 2) 何の出来事か（何・いつ・どこ）」
- このセッションで以前 YES にした出来事と同じなら NO${many ? "（今回の記事どうしが同じ出来事なら YES は1件だけ）" : ""}。迷ったら YES。
- 報告がそろったら submit_result（kind: done）で1記事1行:「<ID>: YES|NO | 理由」
${list}`;
}

export function buildIrisMessage({ requestId, articles, title, link, feedPrompt, subagentModel = "" }) {
  return buildIrisMessageWith({ requestId, articles: articles || [{ title, link }], feedPrompt, subagentModel });
}

/** Wait until the session has no running turn and nothing queued. */
async function waitForIdle(id, view) {
  const deadline = Date.now() + IRIS_IDLE_WAIT_MS;
  let stopped = false;
  for (;;) {
    const { session } = view;
    if (session.status !== "running" && !(session.queue || []).length) return view;
    const runningFor = Date.now() - Date.parse(session.updatedAt || 0);
    if (!stopped && session.status === "running" && runningFor > IRIS_STUCK_TURN_MS) {
      console.warn(`[IRIS] Judge session turn ${session.turns} has run for ${Math.round(runningFor / 60000)} min; stopping it`);
      await irisFetch(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
      stopped = true;
    }
    if (Date.now() > deadline) throw new IrisDefer(`judge session busy (turn ${session.turns} ${session.status})`);
    await sleep(IRIS_POLL_MS);
    view = await getSessionView(id);
    if (!view) return null;
  }
}

async function createJudgeSession(previous) {
  const lastCreated = Date.parse(previous?.createdAt || 0) || 0;
  if (Date.now() - lastCreated < IRIS_MIN_RECREATE_INTERVAL_MS) {
    throw new IrisDefer("judge session needs replacing but one was created less than an hour ago");
  }
  const body = { title: IRIS_SESSION_TITLE, message: IRIS_SETUP_MESSAGE };
  // Normally no modelId: iris uses its work-session default.
  if (process.env.IRIS_MODEL_ID) body.modelId = process.env.IRIS_MODEL_ID;
  const response = await irisFetch("/api/sessions", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new IrisDefer(`iris session creation HTTP ${response.status}`);
  const { id } = await response.json();
  if (typeof id !== "string" || !id) throw new Error("iris returned an invalid session id");
  const pointer = {
    id,
    createdAt: new Date().toISOString(),
    replaces: previous?.id || null,
    judgments: 0,
    consecutiveErrors: 0,
  };
  await savePointer(pointer);
  console.log(`[IRIS] Created judge session ${id}${previous?.id ? ` (replacing ${previous.id})` : ""}`);
  const deadline = Date.now() + IRIS_REPLY_TIMEOUT_MS;
  for (;;) {
    const view = await getSessionView(id, 1);
    if (!view) throw new IrisDefer("new judge session disappeared");
    if (turnFinished(view.session, 1)) return pointer;
    if (Date.now() > deadline) throw new IrisDefer("new judge session setup timeout");
    await sleep(IRIS_POLL_MS);
  }
}

/** Wait for the turn whose input contains `marker` (sent after `baseTurns`) to finish. */
async function waitForTurn(id, baseTurns, marker, deadline) {
  for (;;) {
    const current = await getSessionView(id, baseTurns + 1);
    if (!current) throw new IrisDefer("judge session disappeared while waiting for a reply");
    const turn = (current.turns || []).find((item) => String(item.input?.text || "").includes(marker));
    if (turn && turnFinished(current.session, turn.turn)) return { turn, session: current.session };
    if (Date.now() > deadline) throw new IrisDefer(`no reply for ${marker} within ${Math.round(IRIS_REPLY_TIMEOUT_MS / 1000)}s`);
    await sleep(IRIS_POLL_MS);
  }
}

/** Shrink the conversation in place with "/compact" (the session id does not change). */
async function compactSession(pointer, baseTurns) {
  const marker = `COMPACT-${newRequestId()}`;
  const startedAt = Date.now();
  const response = await irisFetch(`/api/sessions/${encodeURIComponent(pointer.id)}/message`, {
    method: "POST",
    body: JSON.stringify({ text: `/compact [${marker}] ${IRIS_COMPACT_INSTRUCTIONS}` }),
  });
  if (!response.ok) throw new IrisDefer(`iris compact HTTP ${response.status}`);
  const { turn } = await waitForTurn(pointer.id, baseTurns, marker, startedAt + IRIS_REPLY_TIMEOUT_MS);
  const usage = turnUsage(turn);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const updated = { ...pointer, lastCompactedAt: new Date().toISOString() };
  if (usage.compacted) {
    updated.lastContextTokens = usage.compacted.post_tokens || 0;
    updated.compactions = (pointer.compactions || 0) + 1;
    console.log(`[IRIS] Compacted judge session turn ${turn.turn}: ${usage.compacted.pre_tokens} -> ${usage.compacted.post_tokens} tokens in ${seconds}s`);
  } else {
    // Do not retry before the conversation has grown again.
    updated.lastContextTokens = 0;
    console.warn(`[IRIS] Compaction turn ${turn.turn} reported no compaction (${seconds}s)`);
  }
  await savePointer(updated);
  return updated;
}

/** The saved session if it can take a message now; null when it must be replaced. */
async function usableSession(pointer) {
  if (!pointer?.id) return null;
  if ((pointer.consecutiveErrors || 0) >= IRIS_MAX_CONSECUTIVE_ERRORS) {
    console.warn(`[IRIS] Judge session ${pointer.id} failed ${pointer.consecutiveErrors} turns in a row; replacing it`);
    return null;
  }
  const view = await getSessionView(pointer.id);
  if (!view) {
    console.warn(`[IRIS] Judge session ${pointer.id} no longer exists; replacing it`);
    return null;
  }
  return waitForIdle(pointer.id, view);
}

/**
 * Send one judgment message for up to IRIS_BATCH_SIZE articles.
 * @returns per-article decision (null when the reply had no line for it) plus turn info.
 */
async function judgeOnce(params, allowRecreate = true) {
  let pointer = await readPointer();
  let view = await usableSession(pointer);
  if (!view) {
    pointer = await createJudgeSession(pointer);
    view = await usableSession(pointer);
    if (!view) throw new IrisDefer("new judge session is not usable");
  }
  const { id } = pointer;
  if (IRIS_COMPACT_AT_TOKENS > 0 && (pointer.lastContextTokens || 0) >= IRIS_COMPACT_AT_TOKENS) {
    pointer = await compactSession(pointer, view.session.turns);
    view = await usableSession(pointer);
    if (!view) throw new IrisDefer("judge session unusable after compaction");
  }
  const baseTurns = view.session.turns;
  const requestId = newRequestId();
  const subagentModel = await subagentModelFor(view.session.modelId);
  const startedAt = Date.now();

  const response = await irisFetch(`/api/sessions/${encodeURIComponent(id)}/message`, {
    method: "POST",
    body: JSON.stringify({ text: buildIrisMessage({ ...params, requestId, subagentModel }) }),
  });
  if (response.status === 404 || (response.status === 400 && /見つかりません/.test(await response.clone().text()))) {
    if (!allowRecreate) throw new IrisDefer("judge session vanished");
    await savePointer({ ...pointer, consecutiveErrors: IRIS_MAX_CONSECUTIVE_ERRORS });
    return judgeOnce(params, false);
  }
  if (!response.ok) throw new IrisDefer(`iris message HTTP ${response.status}`);

  // Locate the turn that carries this request id, then wait for it to finish.
  const { turn, session } = await waitForTurn(id, baseTurns, requestId, startedAt + IRIS_REPLY_TIMEOUT_MS);
  const usage = turnUsage(turn);
  const turnError = usage.isError || (session.turns === turn.turn && session.status === "error");
  const texts = answerTexts(turn);
  const decisions = params.articles.map((_, index) => parseIrisDecision(texts, articleId(requestId, index)));
  const answered = decisions.filter(Boolean).length;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const latest = await readPointer();
  const base = latest?.id === id ? latest : pointer;
  if (!answered && turnError) {
    await savePointer({ ...base, consecutiveErrors: (base.consecutiveErrors || 0) + 1 });
    throw new IrisDefer(`judge turn ${turn.turn} ended in error: ${session.lastError || "unknown"}`);
  }
  await savePointer({
    ...base,
    judgments: (base.judgments || 0) + answered,
    consecutiveErrors: 0,
    lastTurn: turn.turn,
    lastContextTokens: usage.contextTokens,
    lastJudgedAt: new Date().toISOString(),
  });
  console.log(
    `[IRIS] ${requestId} turn ${turn.turn}: ${answered}/${params.articles.length} answered (${decisions.map((d) => (d ? (d.notify ? "YES" : "NO") : "?")).join(",")}) in ${seconds}s, ${usage.calls} model calls, ${usage.subagents} subagents${subagentModel ? ` (${subagentModel})` : ""}${usage.selfFetches ? `, ${usage.selfFetches} self fetches` : ""}, context ~${usage.contextTokens} tokens${usage.compacted ? ` (auto-compacted from ${usage.compacted.pre_tokens})` : ""}`,
  );
  const fallbackReply = texts.join("\n").slice(0, 500);
  return {
    requestId,
    turn: turn.turn,
    seconds: Number(seconds),
    contextTokens: usage.contextTokens,
    subagents: usage.subagents,
    decisions: decisions.map((decision) =>
      decision ? { notify: decision.notify, reason: decision.reason, rawReply: decision.line } : { missing: true, rawReply: fallbackReply },
    ),
  };
}

// Once iris was found unusable in this run, defer the remaining articles at once
// instead of waiting for the lock/session timeouts again for each of them.
let deferredThisRun = null;

async function defer(key, reason) {
  const count = await bumpDeferral(key).catch(() => IRIS_MAX_DEFERRALS + 1);
  if (count > IRIS_MAX_DEFERRALS) {
    await clearDeferral(key).catch(() => {});
    console.warn(`[IRIS] Gave up after ${count - 1} deferrals, notifying anyway: ${reason}`);
    return { notify: true, error: reason, reason: "iris判定失敗のため通知" };
  }
  console.warn(`[IRIS] Deferring article to the next run (${count}/${IRIS_MAX_DEFERRALS}): ${reason}`);
  return { notify: false, deferred: true, error: reason, reason: `iris判定保留: ${reason}` };
}

const articleKey = (article) => article.entryKey || article.link || article.title;

/**
 * Judge several articles of one feed via iris. Only title and link are sent;
 * the judge has subagents open the URLs. Returns one decision per article, in order.
 * @param {{ articles: { title: string, link?: string, entryKey?: string }[], feedPrompt?: string }} params
 */
export async function shouldNotifyBatchViaIris({ articles, feedPrompt }) {
  if (!feedPrompt?.trim()) {
    return articles.map(() => ({ notify: true, skipped: true, reason: "No feed prompt; notifying" }));
  }
  const results = [];
  for (let start = 0; start < articles.length; start += IRIS_BATCH_SIZE) {
    const chunk = articles.slice(start, start + IRIS_BATCH_SIZE);
    if (deferredThisRun) {
      for (const article of chunk) results.push(await defer(articleKey(article), deferredThisRun));
      continue;
    }
    let locked = false;
    try {
      await acquireLock();
      locked = true;
      const outcome = await judgeOnce({ articles: chunk.map(({ title, link }) => ({ title, link })), feedPrompt });
      for (let i = 0; i < chunk.length; i++) {
        const key = articleKey(chunk[i]);
        const decision = outcome.decisions[i];
        const meta = { requestId: outcome.requestId, turn: outcome.turn, seconds: outcome.seconds, contextTokens: outcome.contextTokens };
        if (decision.missing) {
          // No answer line for this article: judge it again next run rather than guess.
          const deferred = await defer(key, `no answer line for ${articleId(outcome.requestId, i)}`);
          results.push({ ...deferred, ...meta, rawReply: decision.rawReply, error: deferred.error || "unparseable" });
          continue;
        }
        await clearDeferral(key);
        // A YES is the newest "already notified" headline for the next chunk.
        if (decision.notify) rememberNotifiedThisRun(chunk[i]);
        results.push({ ...decision, ...meta });
      }
    } catch (error) {
      if (error instanceof IrisDefer) {
        deferredThisRun = error.message;
        for (const article of chunk) results.push(await defer(articleKey(article), error.message));
        continue;
      }
      console.warn(`[IRIS] Judge failed, notifying anyway: ${error.message}`);
      for (const _ of chunk) results.push({ notify: true, error: error.message, reason: "iris判定失敗のため通知" });
    } finally {
      if (locked) await releaseLock().catch(() => {});
    }
  }
  return results;
}

/** Single-article form of shouldNotifyBatchViaIris. */
export async function shouldNotifyViaIris({ title, link, feedPrompt, entryKey }) {
  const [decision] = await shouldNotifyBatchViaIris({ articles: [{ title, link, entryKey }], feedPrompt });
  return decision;
}

export async function shouldNotifyCombined(params) {
  const mode = getFilterMode();
  const gptPromise = mode === "iris" ? null : shouldNotify(params);
  const irisPromise = mode === "gpt-oss" ? null : shouldNotifyViaIris(params);
  const [gpt, iris] = await Promise.all([gptPromise, irisPromise]);
  if (mode === "gpt-oss") {
    if (gpt.notify) rememberNotifiedThisRun(params);
    return { ...gpt, aiModel: "gpt-oss" };
  }
  if (iris.deferred) return { ...iris, aiModel: mode };
  if (mode === "iris") {
    // The iris judge is the only judge: a duplicate NO is final.
    // (shouldNotifyBatchViaIris already remembered a YES for this run.)
    return { ...iris, aiModel: "iris" };
  }
  const notify = gpt.notify || iris.notify;
  // Remember whatever actually goes out, so a twin article later in this same
  // run (history.json is only written after the feed loop) is still suppressed.
  if (notify && !iris.notify) rememberNotifiedThisRun(params);
  return { notify, rawReply: `gpt-oss: ${gpt.rawReply || gpt.reason || ""}\niris: ${iris.rawReply || iris.reason || ""}`, reason: `gpt-oss=${gpt.notify ? "YES" : "NO"}; iris=${iris.notify ? "YES" : "NO"}`, aiModel: "hybrid" };
}

/**
 * Judge all new articles of one feed. In iris mode only title+link are sent and
 * the articles are batched; the other modes still judge one article at a time
 * with the article body (fetched through `loadBody`).
 */
export async function judgeArticles({ articles, feedPrompt, loadBody }) {
  if (getFilterMode() === "iris") {
    const decisions = await shouldNotifyBatchViaIris({ articles, feedPrompt });
    return decisions.map((decision) => ({ ...decision, aiModel: "iris" }));
  }
  const decisions = [];
  for (const article of articles) {
    const body = loadBody ? await loadBody(article) : undefined;
    decisions.push(await shouldNotifyCombined({ ...article, body: body || undefined, feedPrompt }));
  }
  return decisions;
}
