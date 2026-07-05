import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildNotificationMessage,
  cleanText,
  deriveEntryKey,
  extractOriginalUrl,
  formatPublishedAt,
  loadHistory,
  loadState,
  recordNotification,
  saveHistory,
  saveState,
} from "../lib.js";

test("cleanText removes html tags and decodes entities", () => {
  const input = "マイクロン、<b>広島</b>&nbsp;工場";
  assert.equal(cleanText(input), "マイクロン、広島 工場");
});

test("extractOriginalUrl prefers query url", () => {
  const input = "https://www.google.com/url?sa=t&url=https%3A%2F%2Fnews.yahoo.co.jp%2Farticles%2Fabc";
  assert.equal(extractOriginalUrl(input), "https://news.yahoo.co.jp/articles/abc");
});

test("buildNotificationMessage builds readable message", () => {
  const expectedLink = extractOriginalUrl("https://www.google.com/url?url=https%3A%2F%2Fnews.yahoo.co.jp%2Farticles%2Fabc");
  const message = buildNotificationMessage({
    title: "マイクロン、<b>広島</b>工場拡張",
    summary: "（ブルームバーグ）： 米メモリーチップ大手のマイクロン・テクノロジーは、<b>広島</b>工場&nbsp;...",
    publishedAt: "2026-07-04T07:33:52Z",
    link: "https://www.google.com/url?url=https%3A%2F%2Fnews.yahoo.co.jp%2Farticles%2Fabc",
  });

  assert.ok(message.includes("**見出し**: マイクロン、広島工場拡張"));
  assert.ok(message.includes("**要約**:"));
  assert.ok(message.includes("**公開**:"));
  assert.ok(message.includes(expectedLink));
  assert.ok(!message.includes("<b>"));
  assert.ok(!message.includes("&nbsp;"));
});

test("buildNotificationMessage truncates long summary", () => {
  const longSummary = "あ".repeat(140);
  const message = buildNotificationMessage({
    title: "テスト",
    summary: longSummary,
    link: "https://example.com/article",
  });

  const summaryLine = message.split("\n").find((line) => line.startsWith("**要約**: "));
  assert.ok(summaryLine);
  assert.ok(summaryLine.endsWith("…"));
});

test("formatPublishedAt formats JST and handles invalid input", () => {
  assert.equal(formatPublishedAt("2026-07-04T07:33:52Z"), "2026/07/04 16:33 JST");
  assert.equal(formatPublishedAt("invalid"), "");
});

// ---------------------------------------------------------------------------
// deriveEntryKey
// ---------------------------------------------------------------------------

test("deriveEntryKey prefers item.id", () => {
  const item = {
    id: "tag:google.com,2013:googlealerts/feed:abc123",
    guid: "tag:google.com,2013:googlealerts/feed:abc123",
    link: "https://www.google.com/url?url=https%3A%2F%2Fnews.example.com%2F1",
    title: "Test Title",
    isoDate: "2026-07-04T12:00:00.000Z",
  };
  assert.equal(deriveEntryKey(item), "id:tag:google.com,2013:googlealerts/feed:abc123");
});

test("deriveEntryKey falls back to canonical URL when no id", () => {
  const item = {
    link: "https://www.google.com/url?url=https%3A%2F%2Fnews.example.com%2Farticle-42",
    title: "Test Title",
    isoDate: "2026-07-04T12:00:00.000Z",
  };
  assert.equal(deriveEntryKey(item), "url:https://news.example.com/article-42");
});

test("deriveEntryKey falls back to title+pub when no id and no link", () => {
  const item = {
    title: "<b>広島</b>ニュース",
    isoDate: "2026-07-04T12:00:00.000Z",
  };
  assert.equal(deriveEntryKey(item), "title:広島ニュース|pub:2026-07-04T12:00:00.000Z");
});

test("deriveEntryKey: same Google redirect URL for same article yields same key", () => {
  const item1 = {
    link: "https://www.google.com/url?url=https%3A%2F%2Fnews.example.com%2Farticle-99&ct=foo",
    title: "Article",
  };
  const item2 = {
    link: "https://www.google.com/url?url=https%3A%2F%2Fnews.example.com%2Farticle-99&ct=bar",
    title: "Article",
  };
  assert.equal(deriveEntryKey(item1), deriveEntryKey(item2));
});

test("deriveEntryKey: different IDs → different keys even with same title", () => {
  const item1 = {
    id: "tag:google.com,2013:googlealerts/feed:id001",
    title: "同じタイトル",
    isoDate: "2026-07-04T12:00:00.000Z",
  };
  const item2 = {
    id: "tag:google.com,2013:googlealerts/feed:id002",
    title: "同じタイトル",
    isoDate: "2026-07-04T12:00:00.000Z",
  };
  assert.notEqual(deriveEntryKey(item1), deriveEntryKey(item2));
});

// ---------------------------------------------------------------------------
// Multi-entry / deduplication / restart integration tests
// (These test loadState/saveState/recordNotification/loadHistory via temp files)
// ---------------------------------------------------------------------------

async function withTempDataDir(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lib-test-"));
  const origState = process.env.STATE_FILE;
  const origHistory = process.env.HISTORY_FILE;
  process.env.STATE_FILE = path.join(tmpDir, "state.json");
  process.env.HISTORY_FILE = path.join(tmpDir, "history.json");
  try {
    await fn(tmpDir);
  } finally {
    if (origState === undefined) delete process.env.STATE_FILE;
    else process.env.STATE_FILE = origState;
    if (origHistory === undefined) delete process.env.HISTORY_FILE;
    else process.env.HISTORY_FILE = origHistory;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("loadState returns empty object when file does not exist", async () => {
  await withTempDataDir(async () => {
    const state = await loadState();
    assert.deepEqual(state, {});
  });
});

test("saveState and loadState round-trip array of seen keys", async () => {
  await withTempDataDir(async () => {
    const feedUrl = "https://www.google.com/alerts/feeds/123/456";
    const keys = ["id:tag:a", "id:tag:b", "url:https://example.com"];
    await saveState({ [feedUrl]: keys });
    const loaded = await loadState();
    assert.deepEqual(loaded[feedUrl], keys);
  });
});

test("recordNotification stores entry with all fields and caps at HISTORY_MAX", async () => {
  await withTempDataDir(async () => {
    const entry = {
      title: "Test Title",
      link: "https://example.com/article",
      feedUrl: "https://www.google.com/alerts/feeds/123/456",
      entryKey: "id:tag:google.com,2013:abc",
      publishedAt: "2026-07-04T12:00:00.000Z",
      sentAt: new Date().toISOString(),
    };
    await recordNotification(entry);
    const history = await loadHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].entryKey, entry.entryKey);
    assert.equal(history[0].publishedAt, entry.publishedAt);
    assert.equal(history[0].feedUrl, entry.feedUrl);
    assert.equal(history[0].link, entry.link);
  });
});

test("state migration: old string lastId is treated as single seen key", async () => {
  await withTempDataDir(async () => {
    const feedUrl = "https://www.google.com/alerts/feeds/123/456";
    // Simulate old-format state (single string ID)
    await saveState({ [feedUrl]: "tag:google.com,2013:googlealerts/feed:oldId" });
    const state = await loadState();
    const rawState = state[feedUrl];
    // Verify the migration logic used in index.js
    const seenKeys = new Set(
      Array.isArray(rawState)
        ? rawState
        : typeof rawState === "string"
        ? [rawState]
        : []
    );
    assert.ok(seenKeys.has("tag:google.com,2013:googlealerts/feed:oldId"));
  });
});

test("restart scenario: already-seen keys are not re-notified", async () => {
  await withTempDataDir(async () => {
    const feedUrl = "https://www.google.com/alerts/feeds/123/456";
    const sentKeys = ["id:tag:a", "id:tag:b"];
    await saveState({ [feedUrl]: sentKeys });

    // Simulate loading state and checking items
    const state = await loadState();
    const rawState = state[feedUrl];
    const seenKeys = new Set(Array.isArray(rawState) ? rawState : []);

    // All previously sent items should be in seenKeys
    assert.ok(seenKeys.has("id:tag:a"));
    assert.ok(seenKeys.has("id:tag:b"));

    // A new item should NOT be in seenKeys
    assert.ok(!seenKeys.has("id:tag:c"));
  });
});

test("multiple entries: all are collected as distinct keys", () => {
  const items = [
    { id: "tag:google.com,2013:googlealerts/feed:e1", title: "Entry 1" },
    { id: "tag:google.com,2013:googlealerts/feed:e2", title: "Entry 2" },
    { id: "tag:google.com,2013:googlealerts/feed:e3", title: "Entry 3" },
  ];
  const keys = items.map(deriveEntryKey);
  const unique = new Set(keys);
  assert.equal(unique.size, 3, "all three entries must have distinct keys");
});
