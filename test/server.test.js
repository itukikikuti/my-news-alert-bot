import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const SERVER_PORT = "34567";
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}/`;

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

test("admin page exposes separate Discord and Web Push test actions", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUI_PORT: SERVER_PORT,
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/mock-token",
      STATE_FILE: "/tmp/my-news-alert-bot-server-test/state.json",
      HISTORY_FILE: "/tmp/my-news-alert-bot-server-test/history.json",
      SUBSCRIPTIONS_FILE: "/tmp/my-news-alert-bot-server-test/subscriptions.json",
    },
    stdio: "ignore",
  });

  try {
    const html = await waitForServerReady();
    assert.match(html, /Discord テスト通知送信/);
    assert.match(html, /id="push-send-test-btn"/);
    assert.match(html, /Web Push をテスト送信/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
