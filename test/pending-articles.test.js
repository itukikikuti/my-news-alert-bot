import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

function startFeed() {
  const feed = { entries: [] };
  const server = http.createServer((_, res) => {
    const items = feed.entries
      .map((name) => `<item><guid>${name}</guid><title>${name}</title><link>https://example.test/${name}</link></item>`)
      .join("");
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`);
  });
  return { feed, server };
}

function startIris() {
  const messages = [];
  const session = { id: "judge", title: "通知判定", turns: 0, status: "idle", queue: [] };
  const turns = [];
  const addTurn = (text) => {
    session.turns += 1;
    const ids = [...text.matchAll(/^\[(REQ-\S+?)\] (.*)$/gm)];
    const body = ids.length ? ids.map((m) => `${m[1]}: ${m[2].startsWith("yes") ? "YES" : "NO"} | テスト`).join("\n") : "READY";
    turns.push({
      turn: session.turns,
      input: { text },
      events: [
        { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "mcp__iris__submit_result", input: { kind: "done", body } }] } },
        { type: "result", usage: {} },
      ],
    });
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://x");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      addTurn(JSON.parse(raw).message);
      return send(201, { id: session.id });
    }
    if (url.pathname.endsWith("/transcript")) {
      const from = Number(url.searchParams.get("from")) || 1;
      return send(200, { session, turns: turns.filter((t) => t.turn >= from) });
    }
    if (url.pathname.endsWith("/message")) {
      const { text } = JSON.parse(raw);
      messages.push(text);
      addTurn(text);
      return send(200, { result: "started" });
    }
    send(404, {});
  });
  return { server, messages };
}

test("articles held through a long iris outage are judged later, even after leaving the feed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pending-"));
  const { feed, server: feedServer } = startFeed();
  const feedUrl = `${await listen(feedServer)}/feed`;
  await fs.writeFile(path.join(dir, "rss-urls.json"), JSON.stringify([{ url: feedUrl, prompt: "俵万智さんの出演情報" }]));

  const iris = startIris();
  const irisUrl = await listen(iris.server);
  await new Promise((resolve) => iris.server.close(resolve));

  const env = {
    PATH: process.env.PATH,
    STATE_FILE: path.join(dir, "state.json"),
    IRIS_URL: irisUrl,
    AI_FILTER_MODE: "iris",
    IRIS_BATCH_SIZE: "2",
    IRIS_POLL_MS: "10",
    IRIS_IDLE_WAIT_MS: "300",
    IRIS_REPLY_TIMEOUT_MS: "3000",
    IRIS_LOCK_WAIT_MS: "300",
    FCM_ENABLED: "false",
  };
  const once = async () => (await run(process.execPath, ["index.js"], { cwd: root, env })).stdout;
  const readJson = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));

  try {
    feed.entries = ["yes-a", "no-b", "no-c"];
    for (let i = 0; i < 8; i++) {
      const out = await once();
      assert.equal((out.match(/\[AI-DEFER\]/g) || []).length, 3, `run ${i + 1} holds every article`);
    }
    assert.deepEqual((await readJson("pending-articles.json"))[feedUrl].map((a) => a.entryKey).length, 3);
    assert.deepEqual(await readJson("state.json"), { [feedUrl]: [] }, "held articles stay unseen");
    await assert.rejects(fs.stat(path.join(dir, "history.json")), "nothing is recorded as judged during the outage");

    // Everything has scrolled out of the feed by the time iris comes back.
    feed.entries = [];
    await new Promise((resolve) => iris.server.listen(Number(new URL(irisUrl).port), "127.0.0.1", resolve));
    const out = await once();
    assert.equal(iris.messages.length, 2, "judged in chunks of the batch size");
    const judged = iris.messages.flatMap((text) => [...text.matchAll(/^\[REQ-\S+\] (.*)$/gm)].map((m) => m[1]));
    assert.deepEqual(judged, ["yes-a", "no-b", "no-c"]);
    assert.ok(iris.messages.every((text) => (text.match(/^\[REQ-/gm) || []).length <= 2));
    assert.equal((out.match(/\[AI-DEFER\]/g) || []).length, 0);
    assert.deepEqual((await readJson("pending-articles.json"))[feedUrl], []);
    assert.equal((await readJson("state.json"))[feedUrl].length, 3, "judged articles are now seen");

    await once();
    assert.equal(iris.messages.length, 2, "a judged article is not sent again");
  } finally {
    feedServer.close();
    iris.server.close();
  }
});
