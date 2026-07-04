import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  isValidSubscription,
  loadSubscriptions,
  addSubscription,
  removeSubscription,
} from "../push.js";

// ---------------------------------------------------------------------------
// isValidSubscription
// ---------------------------------------------------------------------------

test("isValidSubscription accepts a well-formed subscription", () => {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: "somekey", auth: "someauth" },
  };
  assert.equal(isValidSubscription(sub), true);
});

test("isValidSubscription rejects missing keys", () => {
  assert.equal(isValidSubscription({ endpoint: "https://example.com/push" }), false);
});

test("isValidSubscription rejects non-https endpoint", () => {
  const sub = {
    endpoint: "http://insecure.example.com/push",
    keys: { p256dh: "k", auth: "a" },
  };
  assert.equal(isValidSubscription(sub), false);
});

test("isValidSubscription rejects null", () => {
  assert.equal(isValidSubscription(null), false);
});

test("isValidSubscription rejects missing auth", () => {
  const sub = {
    endpoint: "https://push.example.com/sub",
    keys: { p256dh: "k" },
  };
  assert.equal(isValidSubscription(sub), false);
});

// ---------------------------------------------------------------------------
// loadSubscriptions / addSubscription / removeSubscription
// (We override the SUBSCRIPTIONS_FILE env var to a tmp file for isolation)
// ---------------------------------------------------------------------------

async function withTempSubscriptionsFile(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-test-"));
  const tmpFile = path.join(tmpDir, "subscriptions.json");
  const original = process.env.SUBSCRIPTIONS_FILE;
  process.env.SUBSCRIPTIONS_FILE = tmpFile;
  try {
    await fn(tmpFile);
  } finally {
    if (original === undefined) {
      delete process.env.SUBSCRIPTIONS_FILE;
    } else {
      process.env.SUBSCRIPTIONS_FILE = original;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("addSubscription persists a subscription", async () => {
  await withTempSubscriptionsFile(async () => {
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test1",
      keys: { p256dh: "pk1", auth: "auth1" },
    };
    await addSubscription(sub);

    const subs = await loadSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, sub.endpoint);
  });
});

test("addSubscription deduplicates by endpoint", async () => {
  await withTempSubscriptionsFile(async () => {
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test2",
      keys: { p256dh: "pk2", auth: "auth2" },
    };
    await addSubscription(sub);
    const updated = { ...sub, keys: { p256dh: "pk2-new", auth: "auth2-new" } };
    await addSubscription(updated);

    const subs = await loadSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].keys.p256dh, "pk2-new");
  });
});

test("removeSubscription removes by endpoint", async () => {
  await withTempSubscriptionsFile(async () => {
    const sub1 = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test3a",
      keys: { p256dh: "pk3a", auth: "auth3a" },
    };
    const sub2 = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test3b",
      keys: { p256dh: "pk3b", auth: "auth3b" },
    };
    await addSubscription(sub1);
    await addSubscription(sub2);
    await removeSubscription(sub1.endpoint);

    const subs = await loadSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, sub2.endpoint);
  });
});

test("loadSubscriptions returns empty array when file does not exist", async () => {
  await withTempSubscriptionsFile(async () => {
    const subs = await loadSubscriptions();
    assert.deepEqual(subs, []);
  });
});
