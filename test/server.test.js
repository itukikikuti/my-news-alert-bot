import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

const SERVER_PORT = "34567";
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}/`;
const TMP_DIR = `${os.tmpdir()}/my-news-alert-bot-server-test`;

async function waitForServerReady() {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(SERVER_URL);
      if (res.ok) {
        return await res.text();
      }
    } catch {
      // retry until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for server");
}

function spawnServer(extraEnv = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUI_PORT: SERVER_PORT,
      STATE_FILE: `${TMP_DIR}/state.json`,
      HISTORY_FILE: `${TMP_DIR}/history.json`,
      RSS_URLS_FILE: `${TMP_DIR}/rss-urls.json`,
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

async function killServer(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("admin page displays RSS management and Discord test form", async () => {
  const child = spawnServer();
  try {
    const html = await waitForServerReady();
    assert.match(html, /RSS フィード管理/);
    assert.match(html, /id="rss-add-input"/);
    assert.match(html, /id="rss-add-btn"/);
    assert.match(html, /id="rss-list-container"/);
    assert.match(html, /Discord テスト送信/);
    assert.match(html, /id="discord-send-test-btn"/);
    assert.match(html, /id="discord-test-title"/);
    assert.match(html, /id="discord-test-body"/);
    assert.match(html, /id="discord-test-url"/);
    // Web Push UI must not appear
    assert.doesNotMatch(html, /Web Push/);
    assert.doesNotMatch(html, /push-subscribe-btn/);
  } finally {
    await killServer(child);
  }
});

test("POST /api/discord/send returns 503 when webhook is not configured", async () => {
  const child = spawnServer({ DISCORD_WEBHOOK_URL: "" });
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/discord/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "テスト" }),
    });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.ok(data.error);
  } finally {
    await killServer(child);
  }
});

test("POST /api/discord/send requires a title", async () => {
  const child = spawnServer({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x/y" });
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/discord/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await killServer(child);
  }
});

test("GET /api/rss returns empty array when no RSS URLs configured", async () => {
  const child = spawnServer();
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  } finally {
    await killServer(child);
  }
});

test("POST /api/rss adds a URL and GET returns it as a feed object", async () => {
  const tmpDir = path.join(os.tmpdir(), "my-news-alert-bot-server-test-rss");
  await fs.mkdir(tmpDir, { recursive: true });
  const rssFile = path.join(tmpDir, "rss-urls.json");

  const child = spawnServer({ RSS_URLS_FILE: rssFile });
  try {
    await waitForServerReady();
    const addRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/feed.xml" }),
    });
    assert.equal(addRes.status, 200);
    const addData = await addRes.json();
    assert.equal(addData.ok, true);

    const getRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`);
    const feeds = await getRes.json();
    assert.ok(feeds.some((f) => f.url === "https://example.com/feed.xml"));
    assert.equal(feeds.find((f) => f.url === "https://example.com/feed.xml").prompt, "");
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PUT /api/rss/prompt saves a per-feed prompt", async () => {
  const tmpDir = path.join(os.tmpdir(), "my-news-alert-bot-server-test-rss-prompt");
  await fs.mkdir(tmpDir, { recursive: true });
  const rssFile = path.join(tmpDir, "rss-urls.json");

  const child = spawnServer({ RSS_URLS_FILE: rssFile });
  try {
    await waitForServerReady();
    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/feed.xml" }),
    });
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/feed.xml",
        prompt: "カープのチケット販売情報以外は通知しないでください",
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    const getRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`);
    const feeds = await getRes.json();
    const feed = feeds.find((f) => f.url === "https://example.com/feed.xml");
    assert.equal(feed.prompt, "カープのチケット販売情報以外は通知しないでください");
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PUT /api/rss/prompt rejects an unknown URL", async () => {
  const child = spawnServer();
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://unknown.example.com/feed", prompt: "x" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await killServer(child);
  }
});

test("DELETE /api/rss removes a URL", async () => {
  const tmpDir = path.join(os.tmpdir(), "my-news-alert-bot-server-test-rss-del");
  await fs.mkdir(tmpDir, { recursive: true });
  const rssFile = path.join(tmpDir, "rss-urls.json");
  await fs.writeFile(rssFile, JSON.stringify([
    "https://example.com/feed1.xml",
    "https://example.com/feed2.xml",
  ]));

  const child = spawnServer({ RSS_URLS_FILE: rssFile });
  try {
    await waitForServerReady();
    const delRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/feed1.xml" }),
    });
    assert.equal(delRes.status, 200);

    const getRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`);
    const feeds = await getRes.json();
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].url, "https://example.com/feed2.xml");
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /api/rss rejects duplicate URL", async () => {
  const tmpDir = path.join(os.tmpdir(), "my-news-alert-bot-server-test-rss-dup");
  await fs.mkdir(tmpDir, { recursive: true });
  const rssFile = path.join(tmpDir, "rss-urls.json");

  const child = spawnServer({ RSS_URLS_FILE: rssFile });
  try {
    await waitForServerReady();
    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/feed.xml" }),
    });
    const dupRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/feed.xml" }),
    });
    assert.equal(dupRes.status, 400);
    const data = await dupRes.json();
    assert.ok(data.error);
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("POST /api/rss rejects invalid URL", async () => {
  const child = spawnServer();
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-valid-url" }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  } finally {
    await killServer(child);
  }
});

