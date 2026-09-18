import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// These tests set OLLAMA_API_KEY / OLLAMA_BASE_URL before importing the module,
// so they must import it dynamically inside each test.

function startOllamaMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function mockReply(content) {
  return (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { content } }));
  };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("isAiFilterEnabled is false without an API key", async () => {
  await withEnv({ OLLAMA_API_KEY: undefined }, async () => {
    const mod = await import(`../ai-filter.js?t=${Date.now()}`);
    assert.equal(mod.isAiFilterEnabled(), false);
  });
});

test("shouldNotify fails open (notifies) when no API key is set", async () => {
  await withEnv({ OLLAMA_API_KEY: undefined }, async () => {
    const mod = await import(`../ai-filter.js?t=${Date.now()}`);
    const decision = await mod.shouldNotify({ title: "テスト記事" });
    assert.equal(decision.notify, true);
    assert.equal(decision.skipped, true);
  });
});

test("shouldNotify returns notify=false when the model says NO", async () => {
  const { server, url } = await startOllamaMock(mockReply("NOTIFY: NO | REASON: ルール外"));
  try {
    await withEnv({ OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: url }, async () => {
      const mod = await import(`../ai-filter.js?t=${Date.now()}`);
      const decision = await mod.shouldNotify({
        title: "カープ以外のニュース",
        body: "関係ない記事",
        feedPrompt: "カープのチケット販売情報以外は通知しない",
        history: [],
      });
      assert.equal(decision.notify, false);
      assert.match(decision.reason, /ルール外/);
    });
  } finally {
    server.close();
  }
});

test("shouldNotify returns notify=true when the model says YES", async () => {
  const { server, url } = await startOllamaMock(mockReply("NOTIFY: YES | REASON: 該当"));
  try {
    await withEnv({ OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: url }, async () => {
      const mod = await import(`../ai-filter.js?t=${Date.now()}`);
      const decision = await mod.shouldNotify({
        title: "カープのチケット販売開始",
        feedPrompt: "カープのチケット販売情報以外は通知しない",
      });
      assert.equal(decision.notify, true);
    });
  } finally {
    server.close();
  }
});

test("shouldNotify fails open when the model reply is unparseable", async () => {
  const { server, url } = await startOllamaMock(mockReply("うーん、よくわかりません"));
  try {
    await withEnv({ OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: url }, async () => {
      const mod = await import(`../ai-filter.js?t=${Date.now()}`);
      const decision = await mod.shouldNotify({ title: "テスト" });
      assert.equal(decision.notify, true);
    });
  } finally {
    server.close();
  }
});

test("shouldNotify fails open on an HTTP error", async () => {
  const { server, url } = await startOllamaMock((req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    await withEnv({ OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: url }, async () => {
      const mod = await import(`../ai-filter.js?t=${Date.now()}`);
      const decision = await mod.shouldNotify({ title: "テスト" });
      assert.equal(decision.notify, true);
      assert.ok(decision.error);
    });
  } finally {
    server.close();
  }
});

test("shouldNotify includes feed prompt and history in the request", async () => {
  let received = null;
  const { server, url } = await startOllamaMock((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received = JSON.parse(raw);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: { content: "NOTIFY: YES | REASON: ok" } }));
    });
  });
  try {
    await withEnv({ OLLAMA_API_KEY: "test-key", OLLAMA_BASE_URL: url }, async () => {
      const mod = await import(`../ai-filter.js?t=${Date.now()}`);
      await mod.shouldNotify({
        title: "新しい記事",
        body: "本文テキスト",
        feedPrompt: "特定ルール",
        history: [{ title: "過去の記事", link: "https://example.com/old" }],
      });
      const content = received.messages[0].content;
      assert.match(content, /特定ルール/);
      assert.match(content, /過去の記事/);
      assert.match(content, /新しい記事/);
      assert.match(content, /本文テキスト/);
    });
  } finally {
    server.close();
  }
});
