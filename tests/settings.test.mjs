import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const nativeRequire = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ["src/main.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "es2022", external: ["obsidian", "electron"] });
class Plugin {
  saved = [];
  failSave = false;
  async saveData(data) {
    if (this.failSave) throw new Error("disk unavailable");
    this.saved.push(structuredClone(data));
  }
}
const module = { exports: {} };
const requireMock = name => name === "obsidian" ? { Plugin, PluginSettingTab: class {}, FileSystemAdapter: class {}, Notice: class {} } : nativeRequire(name);
new Function("require", "module", "exports", compiled.outputFiles[0].text)(requireMock, module, module.exports);
const Bridge = module.exports.default;

test("automatic translation preference is saved and a failed save leaves the current preference unchanged", async () => {
  const bridge = new Bridge();
  assert.equal(bridge.settings.autoTranslate, true);
  await bridge.setAutoTranslate(false);
  assert.equal(bridge.settings.autoTranslate, false);
  assert.deepEqual(bridge.saved, [{ autoTranslate: false }]);
  bridge.failSave = true;
  await assert.rejects(bridge.setAutoTranslate(true), /disk unavailable/);
  assert.equal(bridge.settings.autoTranslate, false);
  bridge.onunload();
});

test("turning automatic translation off stops the active runtime and keeps it stopped", async () => {
  const bridge = new Bridge();
  let stops = 0;
  bridge.autostart = { stop: () => { stops++; } };
  await bridge.setAutoTranslate(false);
  assert.equal(stops, 1);
  assert.equal(bridge.autostart, undefined);
  bridge.onunload();
  assert.equal(stops, 1);
});
