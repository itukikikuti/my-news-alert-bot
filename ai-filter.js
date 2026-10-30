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
//   - Each message is self-contained (full rule + format) and carries a unique
//     request id; the reply is accepted only from the turn whose input contains
//     that id and only if the answer line repeats the id. A late reply to an
//     earlier article can therefore never be taken for the current one.
//   - <data>/iris-judge.lock serialises judges across processes (cron, manual
//     runs), so two messages are never in flight in the session at once.
//   - When iris is busy/unreachable the article is deferred (left unseen and
//     retried next run) instead of being guessed; after IRIS_MAX_DEFERRALS
//     retries it falls back to the old fail-open behaviour (notify).
// The model is iris' work-session default: no modelId is ever sent.
// ---------------------------------------------------------------------------

const IRIS_BASE_URL = (process.env.IRIS_URL || "http://10.0.0.99:3170").replace(/\/$/, "");
const IRIS_SESSION_TITLE = "通知判定";
const DATA_DIR = path.dirname(process.env.STATE_FILE || "/data/state.json");
const IRIS_SESSION_FILE = process.env.IRIS_SESSION_FILE || path.join(DATA_DIR, "iris-session.json");
const IRIS_LOCK_FILE = process.env.IRIS_LOCK_FILE || path.join(DATA_DIR, "iris-judge.lock");
const IRIS_DEFER_FILE = process.env.IRIS_DEFER_FILE || path.join(DATA_DIR, "iris-deferrals.json");
const envMs = (name, fallback) => Number(process.env[name]) || fallback;
const IRIS_HTTP_TIMEOUT_MS = envMs("IRIS_HTTP_TIMEOUT_MS", 30000);
// One judgment normally takes 3-6 s; an automatic compaction inside the turn or
// opening the article URL can take minutes.
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

// Duplicate suppression: every judgment message carries the headlines that were
// already notified (from history.json plus the articles notified earlier in this
// same run), so "the same event from another outlet / an X post" is not sent again.
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

const IRIS_SETUP_MESSAGE = `あなたはニュース通知ボットの判定専用セッションです。これから「通知判定リクエスト」が1件ずつ届きます。
- 各リクエストは独立しています。以前に届いた記事・判定・やり取りは参照せず、そのメッセージに書かれたルールと記事だけで判定してください。
- ただし、各メッセージに添えられた「直近に通知した記事」は、重複通知を避けるためだけに使ってください。
- 回答はメッセージの指示どおり、リクエストIDを付けた1行（YES または NO と短い理由）を submit_result（kind: done）で出してください。
いまは準備の確認です。submit_result（kind: done）で「READY」とだけ出してください。`;

const IRIS_COMPACT_INSTRUCTIONS = "要約には次のことだけを残してください: このセッションはニュース通知ボットの判定専用であること、各「通知判定リクエスト」は独立していて以前の記事・判定を参照しないこと、回答はリクエストIDを付けた1行（YES/NO と短い理由）を submit_result（kind: done）で出すこと。これまでに届いた個々の記事の内容・タイトル・URL・判定結果・判定の傾向や方針の学び・ツールの失敗例は要約に一切含めないでください。";

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

/** Texts the model produced in one turn, oldest first: submit_result bodies and plain replies. */
function answerTexts(turn) {
  const texts = [];
  for (const event of turn?.events || []) {
    if (event.type !== "assistant" || event.parent_tool_use_id) continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && /submit_result$/.test(block.name || "") && typeof block.input?.body === "string") {
        texts.push(block.input.body);
      } else if (block?.type === "text" && block.text?.trim()) {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

const usageTokens = (usage) =>
  (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);

/** Largest single model call of the turn (= current conversation size), error flag, compaction info. */
function turnUsage(turn) {
  const events = turn?.events || [];
  const result = [...events].reverse().find((event) => event.type === "result");
  const perCall = events
    .filter((event) => event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage)
    .map((event) => usageTokens(event.message.usage));
  const boundary = events.find((event) => event.type === "system" && event.subtype === "compact_boundary");
  return {
    isError: Boolean(result?.is_error),
    contextTokens: perCall.length ? Math.max(...perCall) : usageTokens(result?.usage),
    calls: perCall.length,
    compacted: boundary ? boundary.compact_metadata || {} : null,
  };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find "<requestId>: YES|NO ..." in the turn's answers (last one wins). */
export function parseIrisDecision(texts, requestId) {
  const pattern = new RegExp(`${escapeRegExp(requestId)}\\s*[\\]】)]?\\s*[:：]?\\s*\\**\\s*(YES|NO)\\b(.*)`, "i");
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

export function buildIrisMessage({ requestId, title, body, link, feedPrompt, recentHeadlines = [] }) {
  const articleBody = body ? body.slice(0, BODY_EXCERPT_CHARS) : "(本文を取得できませんでした)";
  return `【通知判定リクエスト ${requestId}】
これは独立した1件の判定です。このセッションで以前に届いた記事・判定・やり取りは参照せず、このメッセージ内の通知ルールと記事だけで判定してください。ただし、下の「直近に通知した記事」は重複通知を避けるためだけに使ってください。

# このフィードの通知ルール
${feedPrompt.trim()}

${buildRecentHeadlinesSection(recentHeadlines)}

# 判定対象の記事
タイトル: ${title}
URL: ${link || "(なし)"}
本文: ${articleBody}

# 判定基準
1. 上の「通知ルール」に沿っているか。ルールが除外を指示している内容なら通知しない。
2. 「直近に通知した記事」と同じ出来事（同じ公演・イベント・ニュースについての別媒体の記事、X/ソーシャル投稿、実質同じ内容の続報）なら、通知しない（NO）。新しい事実（日程変更、新たな出演者、公演の追加など）が明確に加わっている場合だけYES。
3. 本文が無い・不十分なときは、URLを開いて確かめてよい。
4. 判断に迷う場合は、通知する側（YES）に倒す。ただし重複の判断（2）が優先です。

# 回答方法
submit_result（kind: done）で、次のどちらかの形式の1行だけを出してください。リクエストIDは必ずそのまま先頭に書くこと。
${requestId}: YES | <30文字以内の理由>
${requestId}: NO | <30文字以内の理由>`;
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
  const response = await irisFetch("/api/sessions", {
    method: "POST",
    // No modelId: iris uses its work-session default.
    body: JSON.stringify({ title: IRIS_SESSION_TITLE, message: IRIS_SETUP_MESSAGE }),
  });
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
  const startedAt = Date.now();

  const response = await irisFetch(`/api/sessions/${encodeURIComponent(id)}/message`, {
    method: "POST",
    body: JSON.stringify({ text: buildIrisMessage({ ...params, requestId }) }),
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
  const decision = parseIrisDecision(answerTexts(turn), requestId);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const latest = await readPointer();
  const base = latest?.id === id ? latest : pointer;
  if (!decision && turnError) {
    await savePointer({ ...base, consecutiveErrors: (base.consecutiveErrors || 0) + 1 });
    throw new IrisDefer(`judge turn ${turn.turn} ended in error: ${session.lastError || "unknown"}`);
  }
  await savePointer({
    ...base,
    judgments: (base.judgments || 0) + 1,
    consecutiveErrors: 0,
    lastTurn: turn.turn,
    lastContextTokens: usage.contextTokens,
    lastJudgedAt: new Date().toISOString(),
  });
  console.log(
    `[IRIS] ${requestId} turn ${turn.turn}: ${decision ? (decision.notify ? "YES" : "NO") : "unparseable"} in ${seconds}s, ${usage.calls} model calls, context ~${usage.contextTokens} tokens${usage.compacted ? ` (auto-compacted from ${usage.compacted.pre_tokens})` : ""}`,
  );
  const rawReply = decision?.line || answerTexts(turn).join("\n").slice(0, 500);
  if (!decision) {
    console.warn(`[IRIS] No answer for ${requestId}; fail-open`);
    return { notify: true, reason: "iris判定を解釈できず通知", rawReply, error: "unparseable", requestId, turn: turn.turn };
  }
  return { notify: decision.notify, reason: decision.reason, rawReply, requestId, turn: turn.turn, seconds: Number(seconds), contextTokens: usage.contextTokens };
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

export async function shouldNotifyViaIris({ title, body, link, feedPrompt, entryKey }) {
  if (!feedPrompt?.trim()) {
    return { notify: true, skipped: true, reason: "No feed prompt; notifying" };
  }
  const key = entryKey || link || title;
  if (deferredThisRun) return defer(key, deferredThisRun);
  let locked = false;
  try {
    await acquireLock();
    locked = true;
    const recentHeadlines = await loadRecentNotifiedHeadlines({ excludeKey: key });
    const decision = await judgeOnce({ title, body, link, feedPrompt, recentHeadlines });
    await clearDeferral(key);
    return decision;
  } catch (error) {
    if (error instanceof IrisDefer) {
      deferredThisRun = error.message;
      return defer(key, error.message);
    }
    console.warn(`[IRIS] Judge failed, notifying anyway: ${error.message}`);
    return { notify: true, error: error.message, reason: "iris判定失敗のため通知" };
  } finally {
    if (locked) await releaseLock().catch(() => {});
  }
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
    if (iris.notify) rememberNotifiedThisRun(params);
    return { ...iris, aiModel: "iris" };
  }
  const notify = gpt.notify || iris.notify;
  // Remember whatever actually goes out, so a twin article later in this same
  // run (history.json is only written after the feed loop) is still suppressed.
  if (notify) rememberNotifiedThisRun(params);
  return { notify, rawReply: `gpt-oss: ${gpt.rawReply || gpt.reason || ""}\niris: ${iris.rawReply || iris.reason || ""}`, reason: `gpt-oss=${gpt.notify ? "YES" : "NO"}; iris=${iris.notify ? "YES" : "NO"}`, aiModel: "hybrid" };
}
