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
const IRIS_BASE_URL = (process.env.IRIS_URL || "http://10.0.0.99:3170").replace(/\/$/, "");
const IRIS_TIMEOUT_MS = 120000;

export function getFilterMode() {
  const mode = (process.env.AI_FILTER_MODE || "hybrid").toLowerCase();
  return ["gpt-oss", "iris", "hybrid"].includes(mode) ? mode : "hybrid";
}

export async function shouldNotifyViaIris({ title, body, link, feedPrompt }) {
  const articleBody = body ? body.slice(0, BODY_EXCERPT_CHARS) : "(本文なし)";
  const rule = feedPrompt?.trim() ? `\nフィード通知ルール: ${feedPrompt.trim()}\n` : "";
  const message = `次の記事を通知すべきか。YES か NO だけ答える。理由は1行。${rule}\nタイトル: ${title}\nURL: ${link || ""}\n本文: ${articleBody}`;
  const headers = { "Content-Type": "application/json" };
  if (process.env.IRIS_TOKEN) headers["x-iris-token"] = process.env.IRIS_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IRIS_TIMEOUT_MS);
  try {
    const create = await fetch(`${IRIS_BASE_URL}/api/sessions`, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ title: `News alert: ${title}`.slice(0, 200), message, ...(process.env.IRIS_MODEL_ID ? { modelId: process.env.IRIS_MODEL_ID } : {}) }),
    });
    if (!create.ok) throw new Error(`session creation HTTP ${create.status}`);
    const { id } = await create.json();
    if (typeof id !== "string" || !id) throw new Error("invalid session id");
    const deadline = Date.now() + IRIS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const stateRes = await fetch(`${IRIS_BASE_URL}/api/state`, { headers, signal: controller.signal });
      if (!stateRes.ok) throw new Error(`state HTTP ${stateRes.status}`);
      const state = await stateRes.json();
      const result = (state.results || []).find((r) => r.sessionId === id);
      if (result) {
        const rawReply = String(result.body || "");
        const match = rawReply.trim().match(/^\s*(YES|NO)\b/i);
        if (!match) return { notify: true, reason: "iris応答を解釈できず通知", rawReply, error: "unparseable" };
        return { notify: match[1].toUpperCase() === "YES", reason: rawReply.trim().split(/\r?\n/, 1)[0].slice(0, 100), rawReply, resultKind: result.kind };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("timeout");
  } catch (e) {
    console.warn(`[IRIS] Filter failed, notifying anyway: ${e.name === "AbortError" ? "timeout" : e.message}`);
    return { notify: true, error: e.name === "AbortError" ? "timeout" : e.message, reason: "iris判定失敗のため通知" };
  } finally {
    clearTimeout(timer);
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
