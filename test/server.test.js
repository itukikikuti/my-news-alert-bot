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
      SUBSCRIPTIONS_FILE: `${TMP_DIR}/subscriptions.json`,
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

test("admin page displays RSS management, Web Push test form, and subscription management", async () => {
  const child = spawnServer();
  try {
    const html = await waitForServerReady();
    assert.match(html, /RSS フィード管理/);
    assert.match(html, /id="rss-add-input"/);
    assert.match(html, /id="rss-add-btn"/);
    assert.match(html, /id="rss-list-container"/);
    assert.match(html, /id="push-send-test-btn"/);
    assert.match(html, /Web Push をテスト送信/);
    assert.match(html, /id="push-test-title"/);
    assert.match(html, /id="push-test-body"/);
    assert.match(html, /id="push-test-url"/);
    assert.match(html, /購読管理/);
    assert.match(html, /id="sub-reload-btn"/);
    assert.match(html, /id="sub-list-container"/);
    // Discord section must not appear
    assert.doesNotMatch(html, /Discord/);
  } finally {
    await killServer(child);
  }
});

test("GET /api/push/subscriptions returns empty array when no subscriptions", async () => {
  const child = spawnServer();
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/push/subscriptions`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  } finally {
    await killServer(child);
  }
});

test("GET /api/push/subscriptions returns list of endpoints after subscribe", async () => {
  const tmpDir = path.join(os.tmpdir(), "my-news-alert-bot-server-test-subs");
  await fs.mkdir(tmpDir, { recursive: true });
  const subsFile = path.join(tmpDir, "subscriptions.json");
  await fs.writeFile(subsFile, JSON.stringify([
    { endpoint: "https://fcm.googleapis.com/push/test1", keys: { p256dh: "k1", auth: "a1" } },
    { endpoint: "https://fcm.googleapis.com/push/test2", keys: { p256dh: "k2", auth: "a2" } },
  ]));

  const child = spawnServer({ SUBSCRIPTIONS_FILE: subsFile });
  try {
    await waitForServerReady();
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/push/subscriptions`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 2);
    // Only endpoint should be returned (keys must not be present)
    assert.ok(data.every((s) => typeof s.endpoint === "string"));
    assert.ok(data.every((s) => !("keys" in s)));
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
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

test("POST /api/rss adds a URL and GET returns it", async () => {
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
    const urls = await getRes.json();
    assert.ok(urls.includes("https://example.com/feed.xml"));
  } finally {
    await killServer(child);
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    const urls = await getRes.json();
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://example.com/feed2.xml");
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

