import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  cleanText,
  deriveEntryKey,
  extractOriginalUrl,
  formatPublishedAt,
  isValidRSSUrl,
  loadHistory,
  loadRSSUrls,
  loadState,
  addRSSUrl,
  removeRSSUrl,
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

// ---------------------------------------------------------------------------
// State / history round-trip tests
// (Override STATE_FILE / HISTORY_FILE env vars via temp dirs for isolation)
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

test("recordNotification stores entry with all fields", async () => {
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
    await saveState({ [feedUrl]: "tag:google.com,2013:googlealerts/feed:oldId" });
    const state = await loadState();
    const rawState = state[feedUrl];
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
    await saveState({ [feedUrl]: ["id:tag:a", "id:tag:b"] });
    const state = await loadState();
    const rawState = state[feedUrl];
    const seenKeys = new Set(Array.isArray(rawState) ? rawState : []);
    assert.ok(seenKeys.has("id:tag:a"));
    assert.ok(seenKeys.has("id:tag:b"));
    assert.ok(!seenKeys.has("id:tag:c"));
  });
});

// ---------------------------------------------------------------------------
// isValidRSSUrl
// ---------------------------------------------------------------------------

test("isValidRSSUrl accepts https URL", () => {
  assert.equal(isValidRSSUrl("https://example.com/feed"), true);
});

test("isValidRSSUrl accepts http URL", () => {
  assert.equal(isValidRSSUrl("http://example.com/feed"), true);
});

test("isValidRSSUrl rejects non-http URL", () => {
  assert.equal(isValidRSSUrl("ftp://example.com/feed"), false);
});

test("isValidRSSUrl rejects empty string", () => {
  assert.equal(isValidRSSUrl(""), false);
});

test("isValidRSSUrl rejects non-string", () => {
  assert.equal(isValidRSSUrl(null), false);
});

// ---------------------------------------------------------------------------
// loadRSSUrls / addRSSUrl / removeRSSUrl
// (Override RSS_URLS_FILE env var to a tmp file for isolation)
// ---------------------------------------------------------------------------

async function withTempRSSFile(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rss-test-"));
  const tmpFile = path.join(tmpDir, "rss-urls.json");
  const originalFile = process.env.RSS_URLS_FILE;
  const originalUrls = process.env.RSS_URLS;
  process.env.RSS_URLS_FILE = tmpFile;
  delete process.env.RSS_URLS;
  try {
    await fn(tmpFile);
  } finally {
    if (originalFile === undefined) {
      delete process.env.RSS_URLS_FILE;
    } else {
      process.env.RSS_URLS_FILE = originalFile;
    }
    if (originalUrls === undefined) {
      delete process.env.RSS_URLS;
    } else {
      process.env.RSS_URLS = originalUrls;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("loadRSSUrls returns empty array when file does not exist and no env var", async () => {
  await withTempRSSFile(async () => {
    const urls = await loadRSSUrls();
    assert.deepEqual(urls, []);
  });
});

test("addRSSUrl persists a URL", async () => {
  await withTempRSSFile(async () => {
    await addRSSUrl("https://feeds.example.com/news");
    const urls = await loadRSSUrls();
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://feeds.example.com/news");
  });
});

test("addRSSUrl rejects duplicate URL", async () => {
  await withTempRSSFile(async () => {
    await addRSSUrl("https://feeds.example.com/news");
    await assert.rejects(
      () => addRSSUrl("https://feeds.example.com/news"),
      /already exists/
    );
  });
});

test("addRSSUrl rejects invalid URL", async () => {
  await withTempRSSFile(async () => {
    await assert.rejects(
      () => addRSSUrl("not-a-url"),
      /Invalid URL/
    );
  });
});

test("removeRSSUrl removes the specified URL", async () => {
  await withTempRSSFile(async () => {
    await addRSSUrl("https://feeds.example.com/a");
    await addRSSUrl("https://feeds.example.com/b");
    await removeRSSUrl("https://feeds.example.com/a");
    const urls = await loadRSSUrls();
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://feeds.example.com/b");
  });
});

test("loadRSSUrls falls back to RSS_URLS env var when file does not exist", async () => {
  await withTempRSSFile(async () => {
    process.env.RSS_URLS = "https://env.example.com/feed1,https://env.example.com/feed2";
    try {
      const urls = await loadRSSUrls();
      assert.deepEqual(urls, ["https://env.example.com/feed1", "https://env.example.com/feed2"]);
    } finally {
      delete process.env.RSS_URLS;
    }
  });
});
