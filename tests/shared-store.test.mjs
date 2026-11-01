import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SharedUserscriptStore } from "../src/shared-userscript-store.ts";
import { environmentSource } from "../src/userscript-environment.ts";
import { isOfficialSettingsPage, isBridgePage } from "../src/webview-bridge.ts";

test("official settings share a persistent store and duplicate writes do not bounce between pages", () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = new SharedUserscriptStore(storage, "test");
  let broadcasts = 0;
  store.subscribe(() => broadcasts++);
  const change = { key: "fullLocalUserConfig", value: { subtitleTranslateService: "bing" }, deleted: false, source: "settings" };
  store.change(change);
  store.change({ ...change, source: "youtube" });
  assert.equal(broadcasts, 1);
  assert.equal(new SharedUserscriptStore(storage, "test").snapshot().fullLocalUserConfig.subtitleTranslateService, "bing");
  store.change({ ...change, deleted: true });
  store.change({ ...change, deleted: true });
  assert.equal(broadcasts, 2);
});

test("page initialization preserves the user's AI choice and isolated reads cannot mutate saved settings", () => {
  const messages = [];
  const context = vm.createContext({ console: { info: value => messages.push(value) }, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {}, localStorage: {}, URL });
  vm.runInContext(environmentSource("test:", "1.34.4", { fullLocalUserConfig: {
    translationService: "gemini-pro", subtitleTranslateService: "claude-max", targetLanguage: "ko",
    subtitle: { youtube: { autoEnableSubtitle: true }, humanSubtitlesPreferred: false }
  } }), context);
  assert.equal(vm.runInContext(`GM_getValue('fullLocalUserConfig').subtitleTranslateService`, context), "claude-max");
  vm.runInContext(`const value=GM_getValue('fullLocalUserConfig');value.subtitleTranslateService='bing';`, context);
  assert.equal(vm.runInContext(`GM_getValue('fullLocalUserConfig').subtitleTranslateService`, context), "claude-max");
  vm.runInContext(`GM_setValue('fullLocalUserConfig',value)`, context);
  assert.ok(messages.some(message => message.includes('"subtitleTranslateService":"bing"')));
  vm.runInContext(`__immersiveYouTubeBridge.dispose()`, context);
});

test("the shared environment attaches only to exact official settings and account routes", () => {
  assert.equal(isOfficialSettingsPage("https://dash.immersivetranslate.com/#subtitle"), true);
  assert.equal(isBridgePage("https://immersivetranslate.com/accounts/login?from=plugin"), true);
  assert.equal(isOfficialSettingsPage("https://dash.immersivetranslate.com.evil.test/"), false);
  assert.equal(isOfficialSettingsPage("https://example.com/?dash.immersivetranslate.com"), false);
  assert.equal(isOfficialSettingsPage("https://immersivetranslate.com/docs/"), false);
});
