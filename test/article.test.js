import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchArticleText } from "../article.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("fetchArticleText extracts the article body from an HTML page", async () => {
  const body = "これは本文の段落です。".repeat(40);
  const articleHtml = `
    <!DOCTYPE html>
    <html lang="ja"><head><title>テスト記事</title></head>
    <body>
      <nav>ナビゲーション</nav>
      <article>
        <h1>テスト記事のタイトル</h1>
        <p>${body}</p>
        <p>${body}</p>
      </article>
      <footer>フッター</footer>
    </body></html>`;

  const { server, url } = await startServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(articleHtml);
  });

  try {
    const text = await fetchArticleText(url);
    assert.ok(text, "should extract text");
    assert.match(text, /テスト記事のタイトル/);
    assert.match(text, /本文の段落/);
    // Navigation/footer boilerplate should not dominate the output.
    assert.doesNotMatch(text, /ナビゲーション/);
  } finally {
    server.close();
  }
});

test("fetchArticleText returns null for non-HTML content", async () => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/pdf");
    res.end("%PDF-1.4");
  });
  try {
    assert.equal(await fetchArticleText(url), null);
  } finally {
    server.close();
  }
});

test("fetchArticleText returns null on HTTP error", async () => {
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    assert.equal(await fetchArticleText(url), null);
  } finally {
    server.close();
  }
});

test("fetchArticleText returns null for invalid or empty URLs", async () => {
  assert.equal(await fetchArticleText(""), null);
  assert.equal(await fetchArticleText(null), null);
  assert.equal(await fetchArticleText("not-a-url"), null);
});

test("fetchArticleText skips obvious non-article file extensions", async () => {
  assert.equal(await fetchArticleText("https://example.com/file.pdf"), null);
  assert.equal(await fetchArticleText("https://example.com/image.png"), null);
});
