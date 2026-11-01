import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EmbeddedFrames } from "../src/embedded-frames.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
class Debugger extends EventEmitter {
  attached = false;
  commands = [];
  urls = new Map();
  pendingWorld;
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  async sendCommand(method, params, session) {
    this.commands.push({ method, params, session });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
    if (method === 'Page.createIsolatedWorld') return this.pendingWorld || { executionContextId: params.frameId };
    if (method === 'Runtime.evaluate') return { result: { value: this.urls.get(params.contextId) || 'https://www.youtube-nocookie.com/embed/example' } };
    return {};
  }
  context(id, frameId, session = '', isDefault = true) {
    this.emit('message', {}, 'Runtime.executionContextCreated', { context: { id, auxData: { frameId, isDefault } } }, session);
  }
}
function setup() {
  const d = new Debugger(), connections = [], errors = [];
  const manager = new EmbeddedFrames(d, { addEventListener() {}, removeEventListener() {} }, target => {
    const connection = { target, starts: 0, disposed: false, async start() { this.starts++; }, async dispose() { this.disposed = true; } };
    connections.push(connection);
    return connection;
  }, error => errors.push(error));
  return { d, connections, errors, manager };
}

test('existing and nested cross-origin frames get isolated bridges without duplicating the top document', async () => {
  const s = setup();
  await s.manager.start();
  s.d.context(1, 'root');
  s.d.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'video-session', targetInfo: { type: 'iframe' } }, '');
  s.d.context(2, 'video', 'video-session');
  s.d.context(2, 'video', 'video-session');
  s.d.context(3, 'video', 'video-session', false);
  await tick();
  assert.equal(s.connections.length, 1);
  assert.ok(s.d.commands.some(c => c.method === 'Runtime.enable' && c.session === 'video-session'));
  assert.equal(s.connections[0].target.getURL(), 'https://www.youtube-nocookie.com/embed/example');
  assert.ok(s.d.commands.some(c => c.method === 'Page.createIsolatedWorld' && c.params.grantUniveralAccess === false));
  await s.manager.dispose();
  assert.equal(s.connections[0].disposed, true);
  assert.equal(s.d.attached, false);
  assert.equal(s.d.listenerCount('message'), 0);
});

test('removing or reloading a frame stops its old bridge while other frames remain active', async () => {
  const s = setup(); await s.manager.start();
  s.d.urls.set('second', 'https://player.vimeo.com/video/example');
  s.d.context(1, 'first', 'one'); s.d.context(2, 'second', 'two'); await tick();
  assert.equal(s.connections[1].target.getURL(), 'https://player.vimeo.com/video/example');
  s.d.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextId: 1 }, 'one');
  assert.equal(s.connections[0].disposed, true);
  assert.equal(s.connections[1].disposed, false);
  s.d.context(3, 'first', 'one'); await tick();
  assert.equal(s.connections.length, 3);
  s.d.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'two' }, '');
  assert.equal(s.connections[1].disposed, true);
  assert.equal(s.connections[2].disposed, false);
  await s.manager.dispose();
});

test('closing a frame during isolated-world creation cannot start a stale bridge; local frames are ignored', async () => {
  const s = setup(); await s.manager.start();
  let resolve; s.d.pendingWorld = new Promise(r => { resolve = r; });
  s.d.context(1, 'delayed');
  s.d.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextId: 1 }, '');
  resolve({ executionContextId: 'delayed' }); await tick();
  assert.equal(s.connections.length, 0); assert.equal(s.errors.length, 0);
  s.d.pendingWorld = undefined; s.d.urls.set('local', 'about:blank');
  s.d.context(2, 'local'); await tick();
  assert.equal(s.connections.length, 0);
  await s.manager.dispose();
});

test('an existing debugger connection is left untouched', async () => {
  const s = setup(); s.d.attached = true;
  await assert.rejects(s.manager.start(), /개발자 도구/);
  await s.manager.dispose();
  assert.equal(s.d.attached, true);
});
