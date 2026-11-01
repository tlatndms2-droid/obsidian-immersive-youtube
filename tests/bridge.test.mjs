import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { environmentSource } from "../src/userscript-environment.ts";
import { allowedUrl, parseRequest } from "../src/translation-transport.ts";
import { isYouTubePage, isBridgePage, WebviewBridge } from "../src/webview-bridge.ts";

function page(storage = {}) {
  const events = new Map();
  const messages = [];
  const localStorage = {
    getItem: key => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = value; },
    removeItem: key => { delete storage[key]; }
  };
  // Storage keys are enumerable in real browser localStorage.
  const context = vm.createContext({
    localStorage: new Proxy(localStorage, { ownKeys: () => Object.keys(storage), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }),
    console: { info: message => messages.push(message) }, setTimeout, clearTimeout,
    addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type),
    URL, navigator: { userAgent: "Mozilla/5.0 Sandbox browser" }, location: { href: "https://www.youtube.com/watch?v=test" }
  });
  return { context, storage, messages, events, run: code => vm.runInContext(code, context) };
}

test("settings survive a new page environment while Korean Google subtitles remain the default", () => {
  const p = page();
  p.run(environmentSource("test:", "1.34.4"));
  p.run(`GM_setValue('example',{saved:true});GM_setValue('fullLocalUserConfig',{unrelated:'preserved'});__immersiveYouTubeBridge.dispose()`);
  const next = page(p.storage);
  next.run(environmentSource("next:", "1.34.4"));
  const saved = JSON.parse(next.run(`JSON.stringify({value:GM_getValue('example'),config:GM_getValue('fullLocalUserConfig'),keys:GM_listValues()})`));
  assert.equal(saved.value.saved, true);
  assert.equal(saved.config.unrelated, "preserved");
  assert.equal(saved.config.targetLanguage, "ko");
  assert.equal(saved.config.subtitleTranslateService, "inherit");
  assert.equal(saved.config.subtitle.humanSubtitlesPreferred, false);
  assert.ok(saved.keys.includes("example"));
  next.run(`__immersiveYouTubeBridge.dispose()`);
});

test("GM requests deliver JSON replies once, and cancellation clears pending callbacks", () => {
  const p = page();
  p.run(environmentSource("test:", "1.34.4"));
  p.run(`globalThis.results=[];GM_xmlhttpRequest({url:'https://translate-pa.googleapis.com/test',responseType:'json',onload:r=>results.push(r.response.text)});`);
  const first = p.messages.map(message => JSON.parse(message.slice(5))).find(message => message.action === "request");
  assert.equal(first.headers["User-Agent"], "Mozilla/5.0 Sandbox browser");
  p.run(`__immersiveYouTubeBridge.reply(${first.id},{status:200,responseText:'{"text":"한국어 결과"}'});__immersiveYouTubeBridge.reply(${first.id},{status:200,responseText:'{}'});`);
  assert.deepEqual(JSON.parse(p.run("JSON.stringify(results)")), ["한국어 결과"]);
  p.run(`globalThis.aborted=0;const request=GM.xmlHttpRequest({url:'https://translate-pa.googleapis.com/test',onabort:()=>aborted++});request.abort();request.abort();__immersiveYouTubeBridge.dispose()`);
  assert.equal(p.run("aborted"), 1);
  assert.equal(p.events.size, 0);
});

test("YouTube embed settings use the official button with modern controls without changing shared rules or normal watch pages", () => {
  const rules = { rules: [{ id: 'youtube-subtitle', 'subtitleRule.add': { quickButtonRule: {
    appendSelector: '.ytp-chrome-controls', insertBeforeSelector: '.ytp-right-controls'
  } } }] };
  for (const url of ['https://www.youtube-nocookie.com/embed/example', 'https://www.youtube.com/embed/example', 'https://www.youtube.com/watch?v=example', 'https://example.com/embed/example']) {
    const p = page(); p.context.location.href = url;
    p.run(environmentSource('test:', '1.34.4', { buildinConfig: rules }));
    const button = JSON.parse(p.run(`JSON.stringify(GM_getValue('buildinConfig').rules[0]['subtitleRule.add'].quickButtonRule)`));
    assert.equal(button.appendSelector.includes('.player-controls-bottom-right'), url.includes('/embed/') && url.includes('youtube'));
    assert.equal(p.run(`GM_getValue('buildinConfig').rules[0]['subtitleRule.add'].quickButtonRule.appendSelector`), button.appendSelector);
    p.run(`GM_setValue('buildinConfig',${JSON.stringify(rules)})`);
    assert.equal(p.messages.some(m => JSON.parse(m.slice(5)).key === 'buildinConfig'), false);
    assert.equal(rules.rules[0]['subtitleRule.add'].quickButtonRule.appendSelector, '.ytp-chrome-controls');
    p.run('__immersiveYouTubeBridge.dispose()');
  }
});

test("web documents are supported while local/app documents and arbitrary transport endpoints stay blocked", () => {
  for (const url of ["https://example.com/article", "http://example.com/", "https://developer.mozilla.org/en-US/docs/Web/JavaScript"]) {
    assert.equal(isBridgePage(url), true);
  }
  for (const url of ["file:///C:/private.md", "obsidian://open", "about:blank", "data:text/html,hello", "javascript:alert(1)", "https://user:password@example.com/", "invalid"]) {
    assert.equal(isBridgePage(url), false);
  }
  for (const url of ["https://youtube.com.evil.test/", "https://example.com/?youtube.com", "http://www.youtube.com/", "https://user@www.youtube.com/"]) {
    assert.equal(isYouTubePage(url), false);
  }
  assert.equal(isYouTubePage("https://www.youtube.com/watch?v=test"), true);
  for (const url of ["https://127.0.0.1/", "http://translate-pa.googleapis.com/", "https://translate-pa.googleapis.com.evil.test/", "https://translate-pa.googleapis.com:444/", "file:///C:/secret"]) {
    assert.throws(() => allowedUrl(url));
  }
  assert.throws(() => parseRequest({ id: 1, url: "https://translate-pa.googleapis.com/", headers: { a: "bad\r\nheader" } }));
  assert.throws(() => parseRequest({ id: 1, url: "https://translate-pa.googleapis.com/", data: {} }));
  assert.equal(parseRequest({ id: 1, url: "https://translate-pa.googleapis.com/", timeout: 999999 }).timeout, 30000);
});

test("verified script injection includes its environment, requests get replies, and unload aborts outstanding work", { skip: !process.env.IMT_TEST_SCRIPT }, async () => {
  const script = await readFile(process.env.IMT_TEST_SCRIPT);
  const p = page();
  const handlers = new Map();
  let officialInjections = 0;
  let requests = 0;
  let observedAbort = false;
  p.context.console.info = message => handlers.get("console-message")?.({ message });
  const target = {
    getURL: () => "https://www.youtube.com/watch?v=test",
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: type => handlers.delete(type),
    executeJavaScript: async code => {
      if (code.endsWith(script.toString("utf8"))) {
        const prelude = code.slice(0, -script.toString("utf8").length);
        p.run(prelude);
        officialInjections++;
        assert.equal(p.run("typeof GM_xmlhttpRequest"), "function");
        return;
      }
      return p.run(code);
    }
  };
  const bridge = new WebviewBridge(target, async (request, signal) => {
    requests++;
    if (request.url.endsWith("/pending")) return new Promise((resolve, reject) => signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }));
    return { status: 200, statusText: "OK", responseText: "한국어 번역 응답", responseHeaders: "", finalUrl: request.url, readyState: 4 };
  });
  await bridge.start(script);
  assert.equal(officialInjections, 1);
  p.run(`globalThis.received='';GM_xmlhttpRequest({url:'https://translate-pa.googleapis.com/test',onload:r=>received=r.responseText});`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.run("received"), "한국어 번역 응답");
  p.run(`GM_xmlhttpRequest({url:'https://translate-pa.googleapis.com/pending'});`);
  await bridge.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(observedAbort, true);
  assert.equal(handlers.size, 0);
});
