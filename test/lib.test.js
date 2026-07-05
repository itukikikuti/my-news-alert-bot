import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  cleanText,
  extractOriginalUrl,
  formatPublishedAt,
  isValidRSSUrl,
  loadRSSUrls,
  addRSSUrl,
  removeRSSUrl,
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
// (We override the RSS_URLS_FILE env var to a tmp file for isolation)
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

