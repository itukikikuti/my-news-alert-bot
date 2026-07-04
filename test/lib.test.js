import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationMessage,
  cleanText,
  extractOriginalUrl,
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
