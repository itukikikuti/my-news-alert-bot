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
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/mock-token",
      STATE_FILE: `${TMP_DIR}/state.json`,
      HISTORY_FILE: `${TMP_DIR}/history.json`,
      SUBSCRIPTIONS_FILE: `${TMP_DIR}/subscriptions.json`,
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

async function killServer(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("admin page displays Discord test form, Web Push test form, and subscription management", async () => {
  const child = spawnServer();
  try {
    const html = await waitForServerReady();
    assert.match(html, /Discord テスト通知送信/);
    assert.match(html, /id="push-send-test-btn"/);
    assert.match(html, /Web Push をテスト送信/);
    assert.match(html, /id="push-test-title"/);
    assert.match(html, /id="push-test-body"/);
    assert.match(html, /id="push-test-url"/);
    assert.match(html, /購読管理/);
    assert.match(html, /id="sub-reload-btn"/);
    assert.match(html, /id="sub-list-container"/);
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
