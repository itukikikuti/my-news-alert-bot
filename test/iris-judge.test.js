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

// Articles of one message, as [{ id, title, url }].
function articlesOf(text) {
  return [...text.matchAll(/^\[(REQ-[A-Z0-9]+-[A-F0-9]+-\d+)\] (.*)\n(.*)$/gm)].map((m) => ({ id: m[1], title: m[2], url: m[3] }));
}

function defaultAnswer(text) {
  const articles = articlesOf(text);
  if (!articles.length) return "READY";
  return articles.map((a) => `${a.id}: ${/俵万智/.test(a.title) ? "YES" : "NO"} | テスト`).join("\n");
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
    const a = await mod.shouldNotifyCombined({ title: "俵万智さんがテレビ出演", body: "本文は送らない", link: "https://a", feedPrompt: rule, entryKey: "a" });
    const b = await mod.shouldNotifyCombined({ title: "台風情報", body: "台風", link: "https://b", feedPrompt: rule, entryKey: "b" });
    assert.equal(a.notify, true);
    assert.equal(b.notify, false);
    assert.equal(mock.created.length, 0, "no new session");
    assert.equal(mock.messages.length, 2);
    assert.match(mock.messages[0], new RegExp(`ルール: ${rule}`));
    assert.match(mock.messages[0], /\] 俵万智さんがテレビ出演\nhttps:\/\/a$/m);
    assert.match(mock.messages[0], /以前 YES にした出来事と同じなら NO/);
    assert.ok(mock.messages[0].length < 700, `short message (${mock.messages[0].length})`);
    assert.equal(mock.messages[0].includes("本文は送らない"), false, "no article body is sent");
    assert.equal(mock.messages[0].includes("本文:"), false);
    assert.match(mock.messages[0], /Agent ツール/);
    assert.match(mock.messages[0], /自分で開かず/);
    assert.match(mock.messages[0], /run_in_background: false/);
    const pointer = JSON.parse(await fs.readFile(path.join(dir, "iris-session.json"), "utf8"));
    assert.equal(pointer.id, "fixed-1");
    assert.equal(pointer.judgments, 2);
    assert.equal(pointer.lastTurn, 4);
  });
});

test("an answer carrying another request id is never accepted; the article is retried next run", async () => {
  const mock = await startIrisMock({ answer: () => "REQ-OLD-ABCDEF-1: NO | 前の記事への回答" });
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const d = await mod.shouldNotifyViaIris({ title: "x", link: "https://x", feedPrompt: rule, entryKey: "x" });
    assert.equal(d.deferred, true);
    assert.equal(d.notify, false);
    assert.match(d.error, /no answer line/);
    const counts = JSON.parse(await fs.readFile(path.join(dir, "iris-deferrals.json"), "utf8"));
    assert.equal(counts.x, 1);
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
    assert.equal(mod.parseIrisDecision([`${id}0: YES`], id), null, "id -1 does not match -10");
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
    assert.match(mock.messages[1], /【通知判定 REQ-/);
    assert.match(mock.messages[0], /YES にした記事の一覧を必ず全件残す/);
    assert.equal(mock.created.length, 0);
    const pointer = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(pointer.id, "fixed-1");
    assert.equal(pointer.compactions, 1);
    assert.equal(pointer.lastContextTokens, 31000);
  });
});

test("a batch is sent as one message with title+URL only and answered per article", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const articles = [
      { title: "俵万智さんが講演", link: "https://a", entryKey: "a" },
      { title: "台風情報", link: "https://b", entryKey: "b" },
      { title: "俵万智さん新歌集", link: "https://c", entryKey: "c" },
    ];
    const ds = await mod.shouldNotifyBatchViaIris({ articles, feedPrompt: rule });
    assert.deepEqual(ds.map((d) => d.notify), [true, false, true]);
    assert.equal(mock.messages.length, 1);
    assert.equal(articlesOf(mock.messages[0]).length, 3);
    assert.match(mock.messages[0], /並列/);
    assert.match(mock.messages[0], /YES は1件だけ/);
    const pointer = JSON.parse(await fs.readFile(path.join(dir, "iris-session.json"), "utf8"));
    assert.equal(pointer.judgments, 3);
  });
});

test("batches are split by IRIS_BATCH_SIZE", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, { IRIS_BATCH_SIZE: "2" }, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const articles = ["俵万智A", "台風B", "地震C"].map((title, i) => ({ title, link: `https://${i}`, entryKey: String(i) }));
    const ds = await mod.shouldNotifyBatchViaIris({ articles, feedPrompt: rule });
    assert.deepEqual(ds.map((d) => d.notify), [true, false, false]);
    assert.equal(mock.messages.length, 2);
    assert.equal(mock.messages[0].includes("俵万智A"), true);
    assert.equal(mock.messages[1].includes("俵万智A"), false, "no headline list in later messages");
  });
});

test("a missing answer for one article of a batch defers only that article", async () => {
  const mock = await startIrisMock({ answer: (text) => { const a = articlesOf(text); return a.length ? `${a[0].id}: NO | 無関係` : "READY"; } });
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    const ds = await mod.shouldNotifyBatchViaIris({ articles: [{ title: "a", link: "https://a", entryKey: "a" }, { title: "b", link: "https://b", entryKey: "b" }], feedPrompt: rule });
    assert.equal(ds[0].notify, false);
    assert.equal(ds[0].deferred, undefined);
    assert.equal(ds[1].deferred, true);
  });
});

test("subagent model: haiku on Claude sessions, inherited on Ollama sessions", async () => {
  const mock = await startIrisMock();
  seedSession(mock, "fixed-1", { modelId: "ollama-x" });
  const original = mock.server.listeners("request")[0];
  mock.server.removeAllListeners("request");
  mock.server.on("request", (req, res) => {
    if (req.url === "/api/settings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ id: "ollama-x", kind: "ollama" }, { id: "claude-x", kind: "claude" }] }));
    }
    return original(req, res);
  });
  await withJudge(mock, {}, async (mod, dir) => {
    assert.equal(await mod.subagentModelFor("claude-x"), "haiku");
    assert.equal(await mod.subagentModelFor("ollama-x"), "");
    assert.equal(await mod.subagentModelFor("unknown"), "");
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    await mod.shouldNotifyViaIris({ title: "台風", link: "https://t", feedPrompt: rule });
    assert.match(mock.messages[0], /model は指定しない/);
    assert.equal(mock.messages[0].includes("haiku"), false);
    process.env.IRIS_SUBAGENT_MODEL = "haiku";
    try {
      assert.equal(await mod.subagentModelFor("ollama-x"), "haiku");
    } finally {
      delete process.env.IRIS_SUBAGENT_MODEL;
    }
  });
});


test("iris messages carry no recent-headline list even when history has notified articles", async () => {
  const mock = await startIrisMock();
  seedSession(mock);
  await withJudge(mock, {}, async (mod, dir) => {
    await fs.writeFile(path.join(dir, "iris-session.json"), JSON.stringify({ id: "fixed-1" }));
    await fs.writeFile(path.join(dir, "history.json"), JSON.stringify([{ title: "ことばの音楽会 千秋楽の記事", notified: true, sentAt: new Date().toISOString(), entryKey: "h1" }]));
    await mod.shouldNotifyViaIris({ title: "無関係な記事", link: "https://x", feedPrompt: rule, entryKey: "x" });
    assert.equal(mock.messages[0].includes("ことばの音楽会"), false);
    assert.equal(mock.messages[0].includes("直近に通知"), false);
  });
});
