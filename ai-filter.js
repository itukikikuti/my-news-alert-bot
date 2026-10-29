// AI notification filtering via Ollama Cloud.
// Filtering is opt-in per feed: the model runs only when the feed has a prompt.
//   - feed prompt empty  -> no API call, every new article is notified
//   - feed prompt set    -> the prompt alone decides (no built-in duplicate rule)
// Set OLLAMA_API_KEY to enable. When unset or on any failure, the article is
// notified (fail-open) so filtering never silently drops everything.

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

function buildPrompt({ title, body, feedPrompt }) {
  const articleBody = body
    ? body.slice(0, BODY_EXCERPT_CHARS)
    : "(本文を取得できませんでした)";

  return `あなたはニュース通知ボットの判定AIです。以下の新着記事を通知すべきか判定してください。

# このフィードの通知ルール
${feedPrompt.trim()}

# 判定対象の新着記事
タイトル: ${title}
本文: ${articleBody}

# 判定基準
1. 上の「通知ルール」に沿っているか。ルールが除外を指示している内容なら通知しない。
2. 判断に迷う場合は、通知する側に倒す。

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
export async function shouldNotify({ title, body, feedPrompt }) {
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
    const prompt = buildPrompt({ title, body, feedPrompt });

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
import fs from "node:fs/promises";
import path from "node:path";

const IRIS_BASE_URL = (process.env.IRIS_URL || "http://10.0.0.99:3170").replace(/\/$/, "");
const IRIS_TIMEOUT_MS = 120000;
const IRIS_ROTATE_TURNS = 40;
const IRIS_ROTATE_TRANSCRIPT_CHARS = 64000;
const IRIS_SESSION_FILE = process.env.IRIS_SESSION_FILE || path.join(path.dirname(process.env.STATE_FILE || "/data/state.json"), "iris-session.json");
const IRIS_INSTRUCTIONS = `あなたはニュース通知判定専用です。このセッションでは記事を1件ずつ受け取ります。各記事の先頭にある番号を必ず保ち、その記事の通知可否を「番号: YES」または「番号: NO」の形式で1行回答してください。理由が必要なら同じ行に短く添えてください。本文が無ければURLを開いて確かめてよいです。判定は必ずYESかNO、理由は1行にしてください。判定に迷った場合は通知する側（YES）にしてください。`;

export function getFilterMode() {
  const mode = (process.env.AI_FILTER_MODE || "hybrid").toLowerCase();
  return ["gpt-oss", "iris", "hybrid"].includes(mode) ? mode : "hybrid";
}

function irisHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (process.env.IRIS_TOKEN) headers["x-iris-token"] = process.env.IRIS_TOKEN;
  return headers;
}

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IRIS_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function readSessionPointer() {
  try {
    return JSON.parse(await fs.readFile(IRIS_SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveSessionPointer(pointer) {
  await fs.mkdir(path.dirname(IRIS_SESSION_FILE), { recursive: true });
  const temporary = `${IRIS_SESSION_FILE}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(pointer, null, 2), { mode: 0o600 });
  await fs.rename(temporary, IRIS_SESSION_FILE);
}

async function irisRequest(url, init = {}) {
  const timeout = withTimeout();
  try {
    return await fetch(url, { ...init, signal: timeout.signal });
  } finally {
    timeout.clear();
  }
}

async function getIrisState() {
  const response = await irisRequest(`${IRIS_BASE_URL}/api/state`, { headers: irisHeaders() });
  if (!response.ok) throw new Error(`iris state HTTP ${response.status}`);
  return response.json();
}

function findSession(state, id) {
  return (state.sessions || []).find((session) => session.id === id);
}

async function waitUntilIdle(id, deadline) {
  while (Date.now() < deadline) {
    const state = await getIrisState();
    const session = findSession(state, id);
    if (!session) return null;
    if (session.status === "error") return null;
    if (session.status !== "running" && !(session.queue || []).length) return { state, session };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("iris session busy timeout");
}

async function waitForResult(id, expectedTurn, articleNumber, deadline) {
  while (Date.now() < deadline) {
    const state = await getIrisState();
    const session = findSession(state, id);
    if (!session) throw new Error("iris session disappeared");
    if (session.status === "error") throw new Error("iris session returned an execution error");
    const result = (state.results || []).find((item) => item.sessionId === id);
    if (session.status !== "running" && !(session.queue || []).length && result?.turn >= expectedTurn) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`iris article ${articleNumber} timeout`);
}

async function createJudgeSession() {
  const response = await irisRequest(`${IRIS_BASE_URL}/api/sessions`, {
    method: "POST",
    headers: irisHeaders(),
    body: JSON.stringify({
      title: "通知判定",
      message: IRIS_INSTRUCTIONS,
      ...(process.env.IRIS_MODEL_ID ? { modelId: process.env.IRIS_MODEL_ID } : {}),
    }),
  });
  if (!response.ok) throw new Error(`iris session creation HTTP ${response.status}`);
  const { id } = await response.json();
  if (typeof id !== "string" || !id) throw new Error("iris returned an invalid session id");
  const pointer = { id, nextArticleNumber: 1 };
  await saveSessionPointer(pointer);
  await waitForResult(id, 1, "setup", Date.now() + IRIS_TIMEOUT_MS);
  console.log("[IRIS] Created persistent judge session: 通知判定");
  return pointer;
}

async function shouldRotateSession(id, session, state) {
  if (session.turns >= IRIS_ROTATE_TURNS) return true;
  try {
    const response = await irisRequest(`${IRIS_BASE_URL}/api/sessions/${encodeURIComponent(id)}/transcript`, { headers: irisHeaders() });
    if (!response.ok) return response.status === 404;
    const transcript = await response.json();
    const serialized = JSON.stringify(transcript);
    const compressed = (transcript.turns || []).some((turn) =>
      (turn.events || []).some((event) =>
        event.type === "system" && /^(compact_boundary|compaction|compact)$/i.test(event.subtype || ""),
      ),
    );
    return serialized.length >= IRIS_ROTATE_TRANSCRIPT_CHARS || compressed;
  } catch {
    // State and article requests remain authoritative; rotate on conservative turn/size thresholds.
    return false;
  }
}

function parseNumberedDecision(text, number) {
  const line = String(text ?? "").split(/\r?\n/).find((row) => {
    const match = row.match(/^\s*(\d+)\s*[:：]\s*(YES|NO)\b/i);
    return match && Number(match[1]) === number;
  });
  if (!line) return null;
  const match = line.match(/^\s*(\d+)\s*[:：]\s*(YES|NO)\b/i);
  return { notify: match[2].toUpperCase() === "YES", reason: line.trim().slice(0, 100) };
}

export async function shouldNotifyViaIris({ title, body, link, feedPrompt }) {
  try {
    let pointer = await readSessionPointer();
    let idle = pointer?.id ? await waitUntilIdle(pointer.id, Date.now() + IRIS_TIMEOUT_MS) : null;
    if (!idle) {
      if (pointer?.id) console.log("[IRIS] Persistent judge session missing or errored; creating a replacement");
      pointer = await createJudgeSession();
      idle = await waitUntilIdle(pointer.id, Date.now() + IRIS_TIMEOUT_MS);
    }
    if (await shouldRotateSession(pointer.id, idle.session, idle.state)) {
      console.log(`[IRIS] Rotating persistent judge session after ${idle.session.turns} turns or large history`);
      pointer = await createJudgeSession();
      idle = await waitUntilIdle(pointer.id, Date.now() + IRIS_TIMEOUT_MS);
    }

    const articleNumber = Number(pointer.nextArticleNumber) || 1;
    pointer.nextArticleNumber = articleNumber + 1;
    await saveSessionPointer(pointer);
    const articleBody = body ? body.slice(0, BODY_EXCERPT_CHARS) : "(本文なし)";
    const rule = feedPrompt?.trim() ? `\n通知ルール: ${feedPrompt.trim()}` : "";
    const text = `[${articleNumber}] ${title}\nURL: ${link || ""}${rule}\n本文: ${articleBody}`;
    const expectedTurn = idle.session.turns + 1;
    const response = await irisRequest(`${IRIS_BASE_URL}/api/sessions/${encodeURIComponent(pointer.id)}/message`, {
      method: "POST",
      headers: irisHeaders(),
      body: JSON.stringify({ text }),
    });
    if (response.status === 404) {
      await fs.rm(IRIS_SESSION_FILE, { force: true });
      return shouldNotifyViaIris({ title, body, link, feedPrompt });
    }
    if (!response.ok) throw new Error(`iris message HTTP ${response.status}`);
    await response.json();

    const result = await waitForResult(pointer.id, expectedTurn, articleNumber, Date.now() + IRIS_TIMEOUT_MS);
    const rawReply = String(result.body || "");
    const decision = parseNumberedDecision(rawReply, articleNumber);
    if (!decision) {
      console.warn(`[IRIS] Missing numbered answer for article ${articleNumber}; fail-open`);
      return { notify: true, reason: "iris番号付き判定を解釈できず通知", rawReply, error: "unparseable" };
    }
    return { ...decision, rawReply, resultKind: result.kind, articleNumber };
  } catch (error) {
    console.warn(`[IRIS] Persistent judge failed, notifying anyway: ${error.name === "AbortError" ? "timeout" : error.message}`);
    return { notify: true, error: error.name === "AbortError" ? "timeout" : error.message, reason: "iris判定失敗のため通知" };
  }
}

export async function shouldNotifyCombined(params) {
  const mode = getFilterMode();
  const gptPromise = mode === "iris" ? null : shouldNotify(params);
  const irisPromise = mode === "gpt-oss" ? null : shouldNotifyViaIris(params);
  const [gpt, iris] = await Promise.all([gptPromise, irisPromise]);
  if (mode === "gpt-oss") return { ...gpt, aiModel: "gpt-oss" };
  if (mode === "iris") return { ...iris, aiModel: "iris" };
  const notify = gpt.notify || iris.notify;
  return { notify, rawReply: `gpt-oss: ${gpt.rawReply || gpt.reason || ""}\niris: ${iris.rawReply || iris.reason || ""}`, reason: `gpt-oss=${gpt.notify ? "YES" : "NO"}; iris=${iris.notify ? "YES" : "NO"}`, aiModel: "hybrid" };
}
