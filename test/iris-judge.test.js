import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A tiny stand-in for the iris API used by the judge:
// GET /api/sessions/:id/transcript, POST /api/sessions, POST /api/sessions/:id/message, POST .../stop
function startIrisMock({ answer, delayMs = 20 } = {}) {
  const sessions = new Map();
  const created = [];
  const messages = [];
  const addTurn = (s, text) => {
    const turn = s.session.turns + 1;
    s.session.turns = turn;
    s.session.status = "running";
    s.session.updatedAt = new Date().toISOString();
    const record = { turn, input: { text }, events: [] };
    s.turns.push(record);
    setTimeout(() => {
      if (text.startsWith("/compact")) {
        record.events = [
          { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 70000, post_tokens: 3000 } },
          { type: "result", usage: {} },
        ];
        s.session.status = "idle";
        return;
      }
      const reply = answer ? answer(text, s) : defaultAnswer(text);
      if (reply === null) return; // never finishes
      if (reply.error) {
        record.events = [{ type: "result", is_error: true, result: reply.error }];
        s.session.status = "error";
        s.session.lastError = reply.error;
        return;
      }
      record.events = [
        { type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 1000, cache_read_input_tokens: 30000 }, content: [{ type: "tool_use", name: "mcp__iris__submit_result", input: { kind: "done", body: reply } }] } },
        { type: "result", usage: { input_tokens: 1000, cache_read_input_tokens: 30000 } },
      ];
      s.session.status = "idle";
    }, delayMs);
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    let m;
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const b = JSON.parse(body);
      created.push(b);
      const id = `new-${created.length}`;
      const s = { session: { id, title: b.title, turns: 0, status: "idle", queue: [] }, turns: [] };
      sessions.set(id, s);
      addTurn(s, b.message);
      return send(201, { id });
    }
    if ((m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return send(404, { error: "セッションが見つかりません" });
      const from = Number(url.searchParams.get("from")) || 1;
      return send(200, { session: s.session, turns: s.turns.filter((t) => t.turn >= from) });
    }
    if ((m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return send(400, { error: "セッションが見つかりません: x" });
      const { text } = JSON.parse(body);
      messages.push(text);
      addTurn(s, text);
      return send(200, { result: "started" });
    }
    if ((m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      s.session.status = "error";
      return send(200, { ok: true });
    }
    send(404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, sessions, created, messages });
    });
  });
}

function defaultAnswer(text) {
  const id = text.match(/REQ-[A-Z0-9]+-[A-F0-9]+/)?.[0];
  if (!id) return "READY";
  return `${id}: ${/俵万智/.test(text.split("# 判定対象の記事")[1] || "") ? "YES" : "NO"} | テスト`;
}

async function withJudge(mock, env, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-judge-"));
  const vars = {
    IRIS_URL: mock.url,
    STATE_FILE: path.join(dir, "state.json"),
    IRIS_SESSION_FILE: undefined,
    IRIS_LOCK_FILE: undefined,
    IRIS_DEFER_FILE: undefined,
    IRIS_POLL_MS: "10",
    IRIS_IDLE_WAIT_MS: "300",
    IRIS_REPLY_TIMEOUT_MS: "1000",
    IRIS_LOCK_WAIT_MS: "300",
    AI_FILTER_MODE: "iris",
    ...env,
  };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`../ai-filter.js?t=${Date.now()}-${Math.random()}`);
    return await fn(mod, dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mock.server.close();
  }
}

const rule = "俵万智さんの出演情報などがあれば教えてください";

function seedSession(mock, id = "fixed-1", extra = {}) {
  mock.sessions.set(id, { session: { id, title: "通知判定", turns: 2, status: "idle", queue: [], ...extra }, turns: [] });
}

test("reuses the saved session and matches the reply by request id", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1", createdAt: "2026-01-01T00:00:00Z" }));
    const a = await mod.shouldNotifyCombined({ title: "俵万智さんがテレビ出演", body: "俵万智", link: "https://a", feedPrompt: rule, entryKey: "a" });
    const b = await mod.shouldNotifyCombined({ title: "台風情報", body: "台風", link: "https://b", feedPrompt: rule, entryKey: "b" });
    assert.equal(a.notify, true);
    assert.equal(b.notify, false);
    assert.equal(mock.created.length, 0, "no new session");
    assert.equal(mock.messages.length, 2);
    assert.match(mock.messages[0], /このメッセージ内の通知ルールと記事だけで判定/);
    assert.match(mock.messages[0], new RegExp(rule));
    const pointer = JSON.parse(await fs.readFile(path.join(dir, "iris-session.json"), "utf8"));
    assert.equal(pointer.id, "fixed-1");
    assert.equal(pointer.judgments, 2);
    assert.equal(pointer.lastTurn, 4);
  });
});

test("an answer carrying another request id is never accepted", async () => {
  const mock = await startIrisMock({ answer: () => "REQ-OLD-ABCDEF: NO | 前の記事への回答" });
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const d = await mod.shouldNotifyViaIris({ title: "x", link: "https://x", feedPrompt: rule });
    assert.equal(d.error, "unparseable");
    assert.equal(d.notify, true, "fail-open like before");
  });
});

test("waits for a still-running previous turn before sending", async () => {
  const mock = await startIrisMock();
  seedSession(mock, "fixed-1", { status: "running", updatedAt: new Date().toISOString() });
  setTimeout(() => (mock.sessions.get("fixed-1").session.status = "idle"), 100);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const d = await mod.shouldNotifyViaIris({ title: "俵万智", body: "俵万智", feedPrompt: rule });
    assert.equal(d.notify, true);
    assert.equal(d.turn, 3);
  });
});

test("busy session defers the article and the rest of the run", async () => {
  const mock = await startIrisMock();
  seedSession(mock, "fixed-1", { status: "running", updatedAt: new Date().toISOString() });
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const a = await mod.shouldNotifyCombined({ title: "a", feedPrompt: rule, entryKey: "a" });
    const t0 = Date.now();
    const b = await mod.shouldNotifyCombined({ title: "b", feedPrompt: rule, entryKey: "b" });
    assert.equal(a.deferred, true);
    assert.equal(b.deferred, true);
    assert.ok(Date.now() - t0 < 200, "second article is deferred without waiting again");
    assert.equal(mock.messages.length, 0);
    assert.equal(mock.created.length, 0);
  });
});

test("a deferred article falls back to notify after the retry limit", async () => {
  const mock = await startIrisMock();
  seedSession(mock, "fixed-1", { status: "running", updatedAt: new Date().toISOString() });
  await withJudge(mock, { IRIS_IDLE_WAIT_MS: "20" }, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    await fs.writeFile(path.join(dir, "iris-deferrals.json"), JSON.stringify({ k: 5 }));
    const d = await mod.shouldNotifyViaIris({ title: "a", feedPrompt: rule, entryKey: "k" });
    assert.equal(d.notify, true);
    assert.equal(d.deferred, undefined);
  });
});

test("missing session is recreated once without a modelId", async () => {
  const mock = await startIrisMock();
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "gone", createdAt: "2026-01-01T00:00:00Z" }));
    const a = await mod.shouldNotifyViaIris({ title: "俵万智", body: "俵万智", feedPrompt: rule });
    const b = await mod.shouldNotifyViaIris({ title: "台風", body: "台風", feedPrompt: rule });
    assert.equal(a.notify, true);
    assert.equal(b.notify, false);
    assert.equal(mock.created.length, 1);
    assert.equal(mock.created[0].title, "通知判定");
    assert.equal("modelId" in mock.created[0], false);
    const pointer = JSON.parse(await fs.readFile(path.join(dir, "iris-session.json"), "utf8"));
    assert.equal(pointer.id, "new-1");
    assert.equal(pointer.replaces, "gone");
  });
});

test("first run without a pointer creates the session", async () => {
  const mock = await startIrisMock();
  await withJudge(mock, {}, async (mod) => {
    const a = await mod.shouldNotifyViaIris({ title: "台風", feedPrompt: rule });
    assert.equal(a.notify, false);
    assert.equal(mock.created.length, 1);
  });
});

test("repeated turn errors replace the session, but not more than once an hour", async () => {
  const mock = await startIrisMock({ answer: (text) => (text.includes("REQ-") ? { error: "API Error: 500" } : "READY") });
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    const file = path.join(dir, "iris-session.json");
    await fs.writeFile(file, JSON.stringify({ id: "fixed-1", createdAt: "2026-01-01T00:00:00Z" }));
    for (let i = 0; i < 3; i++) {
      const d = await mod.shouldNotifyViaIris({ title: `a${i}`, feedPrompt: rule, entryKey: `a${i}` });
      assert.equal(d.deferred, true);
      // a fresh process per cron run
      mod = await import(`../ai-filter.js?t=${Date.now()}-${Math.random()}`);
    }
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).consecutiveErrors, 3);
    await mod.shouldNotifyViaIris({ title: "b", feedPrompt: rule, entryKey: "b" });
    assert.equal(mock.created.length, 1, "replaced once");
    const pointer = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(pointer.replaces, "fixed-1");
    // The replacement fails too: no second replacement within the hour.
    for (let i = 0; i < 4; i++) {
      mod = await import(`../ai-filter.js?t=${Date.now()}-${Math.random()}`);
      await mod.shouldNotifyViaIris({ title: `c${i}`, feedPrompt: rule, entryKey: `c${i}` });
    }
    assert.equal(mock.created.length, 1);
  });
});

test("a held lock defers instead of sending concurrently", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    await fs.writeFile(path.join(dir, "iris-judge.lock"), JSON.stringify({ owner: "other-host:1" }));
    const d = await mod.shouldNotifyViaIris({ title: "a", feedPrompt: rule });
    assert.equal(d.deferred, true);
    assert.equal(mock.messages.length, 0);
  });
});

test("parseIrisDecision accepts bracketed ids and ignores other ids", async () => {
  const mock = await startIrisMock();
  await withJudge(mock, {}, async (mod) => {
    const id = "REQ-ABC-123456";
    assert.equal(mod.parseIrisDecision([`[${id}]: YES — 出演情報`], id).notify, true);
    assert.equal(mod.parseIrisDecision([`**${id}: NO** | 無関係`], id).notify, false);
    assert.equal(mod.parseIrisDecision([`REQ-ZZZ-000000: YES`], id), null);
    assert.equal(mod.parseIrisDecision([`${id}: YES`, `${id}: NO | 訂正`], id).notify, false);
  });
});

test("no feed prompt means no iris message", async () => {
  const mock = await startIrisMock();
  await withJudge(mock, {}, async (mod) => {
    const d = await mod.shouldNotifyViaIris({ title: "a" });
    assert.equal(d.notify, true);
    assert.equal(d.skipped, true);
    assert.equal(mock.messages.length + mock.created.length, 0);
  });
});

test("compacts the same session in place once the context passes the threshold", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, { IRIS_COMPACT_AT_TOKENS: "60000" }, async (mod, dir) => {
    const file = path.join(dir, "iris-session.json");
    await fs.writeFile(file, JSON.stringify({ id: "fixed-1", lastContextTokens: 70000 }));
    const a = await mod.shouldNotifyViaIris({ title: "台風", feedPrompt: rule });
    const b = await mod.shouldNotifyViaIris({ title: "俵万智", body: "俵万智", feedPrompt: rule });
    assert.equal(a.notify, false);
    assert.equal(b.notify, true);
    assert.equal(mock.messages.length, 3);
    assert.match(mock.messages[0], /^\/compact \[COMPACT-REQ-/);
    assert.match(mock.messages[1], /通知判定リクエスト/);
    assert.equal(mock.created.length, 0);
    const pointer = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(pointer.id, "fixed-1");
    assert.equal(pointer.compactions, 1);
    assert.equal(pointer.lastContextTokens, 31000);
  });
});

test("includes recent notified headlines from history, but not skipped or old ones", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(dir, "history.json"),
      JSON.stringify([
        { title: "ことばの音楽会 千秋楽の記事", notified: true, sentAt: now, entryKey: "h1" },
        { title: "通知していない記事", notified: false, sentAt: now, entryKey: "h2" },
        { title: "古すぎる通知", notified: true, sentAt: "2020-01-01T00:00:00Z", entryKey: "h3" },
      ]),
    );
    await mod.shouldNotifyViaIris({ title: "無関係な記事", body: "台風", feedPrompt: rule, entryKey: "x" });
    const message = mock.messages[0];
    assert.match(message, /# 直近に通知した記事/);
    assert.match(message, /ことばの音楽会 千秋楽の記事/);
    assert.equal(message.includes("通知していない記事"), false);
    assert.equal(message.includes("古すぎる通知"), false);
    assert.match(message, /通知しないでください/);
  });
});

test("a twin article notified earlier in the same run is not notified again", async () => {
  const mock = await startIrisMock({
    answer: (text) => {
      const id = text.match(/REQ-[A-Z0-9]+-[A-F0-9]+/)?.[0];
      const title = text.match(/タイトル: (.*)/)?.[1] || "";
      const recent = text.split("# 直近に通知した記事")[1]?.split("# 判定対象の記事")[0] || "";
      return `${id}: ${recent.includes(title) ? "NO" : "YES"} | 重複チェック`;
    },
  });
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const first = await mod.shouldNotifyCombined({ title: "秋吉久美子が俵万智の短歌を朗読", body: "俵万智", feedPrompt: rule, entryKey: "e1" });
    const twin = await mod.shouldNotifyCombined({ title: "秋吉久美子が俵万智の短歌を朗読", body: "俵万智", feedPrompt: rule, entryKey: "e2" });
    const other = await mod.shouldNotifyCombined({ title: "春画展の音声ガイドを俵万智が担当", body: "俵万智", feedPrompt: rule, entryKey: "e3" });
    assert.equal(first.notify, true);
    assert.equal(twin.notify, false, "the same headline notified in this run is suppressed");
    assert.equal(other.notify, true, "a different event still notifies");
    assert.match(mock.messages[1], /秋吉久美子が俵万智の短歌を朗読/);
  });
});
