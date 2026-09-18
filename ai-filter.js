// AI notification filtering via Ollama Cloud.
// Decides whether a new article should be notified, using:
//   - the feed's per-feed prompt (e.g. "カープのチケット販売情報以外は通知しない")
//   - the recent notification history, to suppress duplicate/republished content
// Set OLLAMA_API_KEY to enable. When unset or on any failure, the article is
// notified (fail-open) so filtering never silently drops everything.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "https://ollama.com";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "minimax-m3";
const REQUEST_TIMEOUT_MS = 60000;

// How many recent notifications to show the model for duplicate detection.
const HISTORY_WINDOW = 30;
// How much article body to include in the prompt (keeps requests small).
const BODY_EXCERPT_CHARS = 1200;

function getApiKey() {
  return process.env.OLLAMA_API_KEY || "";
}

export function isAiFilterEnabled() {
  return Boolean(getApiKey());
}

function buildPrompt({ title, body, feedPrompt, history }) {
  const historyLines = history.length
    ? history
        .map((h, i) => `${i + 1}. ${h.title}${h.link ? ` (${h.link})` : ""}`)
        .join("\n")
    : "(なし)";

  const articleBody = body
    ? body.slice(0, BODY_EXCERPT_CHARS)
    : "(本文を取得できませんでした)";

  const customRule = feedPrompt?.trim()
    ? feedPrompt.trim()
    : "(指定なし — 新着記事は基本的に通知する)";

  return `あなたはニュース通知ボットの判定AIです。以下の新着記事を通知すべきか判定してください。

# このフィードの通知ルール
${customRule}

# 最近すでに通知した記事(重複判定用)
${historyLines}

# 判定対象の新着記事
タイトル: ${title}
本文: ${articleBody}

# 判定基準
1. 上の「通知ルール」に沿っているか。ルールが除外を指示している内容なら通知しない。
2. 「最近すでに通知した記事」と内容が実質同じ(転載・続報・重複)なら通知しない。
3. 判断に迷う場合は、通知する側に倒す。

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
 * @param {{ title: string, body?: string, feedPrompt?: string, history?: Array<{title:string,link?:string}> }} params
 * @returns {Promise<{ notify: boolean, reason?: string, skipped?: boolean, error?: string }>}
 */
export async function shouldNotify({ title, body, feedPrompt, history = [] }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { notify: true, skipped: true, reason: "AI filter disabled (no API key)" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const prompt = buildPrompt({
      title,
      body,
      feedPrompt,
      history: history.slice(0, HISTORY_WINDOW),
    });

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
    const decision = parseDecision(extractContent(json));
    if (!decision) {
      // Unparseable answer: fail open (notify) but surface the reason.
      console.warn("[AI] Unparseable decision, notifying anyway:", extractContent(json).slice(0, 120));
      return { notify: true, reason: "AI応答を解釈できず通知" };
    }
    return decision;
  } catch (e) {
    console.warn(`[AI] Filter failed, notifying anyway: ${e.message}`);
    return { notify: true, error: e.message, reason: "AI判定失敗のため通知" };
  } finally {
    clearTimeout(timeout);
  }
}
