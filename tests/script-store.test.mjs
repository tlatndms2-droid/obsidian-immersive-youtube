import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptStore, SCRIPT_VERSION, verifyScript } from "../src/script-store.ts";

test("HTML error pages and altered scripts are rejected", () => {
  assert.throws(() => verifyScript(Buffer.from("<html>Download denied</html>")));
  assert.throws(() => verifyScript(Buffer.from(`// ==UserScript==\n// @version ${SCRIPT_VERSION}\nmodified`)), /검증한 파일과 다릅니다/);
});

test("failed concurrent downloads preserve the previous cache and leave no temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imt-store-test-"));
  try {
    let attempts = 0;
    const store = new ScriptStore(directory, async () => {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return Buffer.from("<html>service unavailable</html>");
    });
    await writeFile(store.scriptPath, "previous-file");
    const results = await Promise.allSettled([store.ensure(), store.ensure()]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(attempts, 2); // Two official URLs, shared by both callers.
    assert.equal(await readFile(store.scriptPath, "utf8"), "previous-file");
    assert.deepEqual(await readdir(directory), [`immersive-translate-${SCRIPT_VERSION}.user.js`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual download bypasses a valid cache, preserves it on failure, and can retry successfully", { skip: !process.env.IMT_TEST_SCRIPT }, async () => {
  const official = await readFile(process.env.IMT_TEST_SCRIPT);
  const directory = await mkdtemp(join(tmpdir(), "imt-refresh-test-"));
  try {
    let attempts = 0, fail = true;
    const store = new ScriptStore(directory, async () => {
      attempts++;
      if (fail) throw new Error("offline");
      return official;
    });
    await writeFile(store.scriptPath, official);
    await assert.rejects(store.ensure(true), /offline/);
    assert.deepEqual(await readFile(store.scriptPath), official);
    assert.equal((await store.ensure()).source, "cache");
    assert.equal(attempts, 2);
    fail = false;
    assert.equal((await store.ensure(true)).source, "download");
    assert.equal(attempts, 3);
    assert.deepEqual(await readFile(store.scriptPath), official);
    assert.deepEqual(await readdir(directory), [`immersive-translate-${SCRIPT_VERSION}.user.js`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
