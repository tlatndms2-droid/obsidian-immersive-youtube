import test from "node:test";
import assert from "node:assert/strict";
import { WebviewAutoStart } from "../src/webview-autostart.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Target {
  url = "https://www.youtube.com/watch?v=first";
  readiness = Promise.resolve("complete");
  handlers = new Map();
  getURL() { return this.url; }
  executeJavaScript() { return this.readiness; }
  addEventListener(type, fn) { this.handlers.set(type, fn); }
  removeEventListener(type) { this.handlers.delete(type); }
  emit(type, event = {}) { this.handlers.get(type)?.(event); }
}

function setup() {
  const connections = [], errors = [];
  let nextStart;
  const manager = new WebviewAutoStart(target => {
    const connection = {
      target, starts: 0, disposed: false,
      async start() { this.starts++; if (nextStart) { const wait = nextStart; nextStart = undefined; await wait; } },
      async dispose() { this.disposed = true; }
    };
    connections.push(connection);
    return connection;
  }, error => errors.push(error));
  return { manager, connections, errors, delayNext: promise => { nextStart = promise; } };
}

test("enabling on an existing YouTube tab injects once despite repeated scans and video changes", async () => {
  const s = setup(), target = new Target();
  s.manager.synchronizeTargets([target]);
  await tick();
  s.manager.synchronizeTargets([target]);
  target.emit("dom-ready");
  target.url = "https://www.youtube.com/watch?v=second";
  target.emit("did-start-navigation", { isMainFrame: true, isInPlace: true });
  target.emit("did-navigate-in-page", { isMainFrame: true });
  await tick();
  assert.equal(s.connections.length, 1);
  assert.equal(s.connections[0].disposed, false);
  s.manager.stop();
  assert.equal(target.handlers.size, 0);
});

test("full reload cancels the old connection and starts one connection in the new document", async () => {
  const s = setup(), target = new Target();
  s.manager.synchronizeTargets([target]);
  await tick();
  target.emit("did-start-navigation", { isMainFrame: false });
  assert.equal(s.connections[0].disposed, false);
  target.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  assert.equal(s.connections[0].disposed, true);
  target.emit("dom-ready");
  target.emit("dom-ready");
  await tick();
  assert.equal(s.connections.length, 2);
  assert.equal(s.connections[1].starts, 1);
  s.manager.stop();
});

test("ordinary article pages connect once across SPA changes and reconnect after a reload", async () => {
  const s = setup(), target = new Target();
  target.url = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
  s.manager.synchronizeTargets([target]);
  await tick();
  target.url += "#reference";
  target.emit("did-navigate-in-page", { isMainFrame: true });
  target.emit("dom-ready");
  await tick();
  assert.equal(s.connections.length, 1);
  target.emit("did-start-navigation", { isMainFrame: true });
  target.emit("dom-ready");
  await tick();
  assert.equal(s.connections.length, 2);
  assert.equal(s.connections[0].disposed, true);
  s.manager.stop();
});

test("navigation while readiness or injection is pending cannot resurrect an old connection", async () => {
  const s = setup(), target = new Target(), ready = deferred(), start = deferred();
  target.readiness = ready.promise;
  s.manager.synchronizeTargets([target]);
  target.emit("did-start-navigation", { isMainFrame: true });
  ready.resolve("complete");
  await tick();
  assert.equal(s.connections.length, 0);
  s.delayNext(start.promise);
  target.emit("dom-ready");
  target.emit("did-start-navigation", { isMainFrame: true });
  target.emit("dom-ready");
  start.reject(new Error("old page disappeared"));
  await tick();
  assert.equal(s.connections.length, 2);
  assert.equal(s.connections[0].disposed, true);
  assert.equal(s.connections[1].disposed, false);
  assert.equal(s.errors.length, 0);
  s.manager.stop();
});

test("tabs are independent; closing one and navigating another to a local document clean their connections", async () => {
  const s = setup(), first = new Target(), second = new Target(), other = new Target();
  other.url = "file:///C:/not-a-webpage.html";
  s.manager.synchronizeTargets([first, second, other]);
  await tick();
  assert.equal(s.connections.length, 2);
  s.manager.synchronizeTargets([second, other]);
  assert.equal(s.connections[0].disposed, true);
  assert.equal(first.handlers.size, 0);
  assert.equal(s.connections[1].disposed, false);
  second.emit("did-start-navigation", { isMainFrame: true });
  second.url = "obsidian://open?vault=example";
  second.emit("dom-ready");
  other.emit("did-start-navigation", { isMainFrame: true });
  other.url = "https://www.youtube.com/watch?v=third";
  other.emit("dom-ready");
  await tick();
  assert.equal(s.connections[1].disposed, true);
  assert.equal(s.connections.length, 3);
  s.manager.stop();
  other.emit("dom-ready");
  s.manager.synchronizeTargets([first]);
  assert.equal(s.connections.length, 3);
  assert.equal(second.handlers.size + other.handlers.size, 0);
});

test("a webview created after its view container is discovered is picked up by the observer", async () => {
  const s = setup(), target = new Target(), observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  let targets = [];
  const root = { isConnected: true, ownerDocument: { defaultView: { MutationObserver: Observer } }, querySelectorAll: () => targets };
  s.manager.synchronize([root]);
  targets = [target];
  observers[0].callback();
  await tick();
  assert.equal(s.connections.length, 1);
  targets = [];
  observers[0].callback();
  assert.equal(s.connections[0].disposed, true);
  s.manager.synchronize([]);
  assert.equal(observers[0].disconnected, true);
  s.manager.stop();
});
