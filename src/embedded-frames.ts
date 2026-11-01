import { isBridgePage, type WebviewTarget } from "./webview-bridge.ts";
import type { Connection, CreateConnection } from "./webview-autostart.ts";

type Debugger = {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  on(name: string, listener: (...args: any[]) => void): void;
  removeListener(name: string, listener: (...args: any[]) => void): void;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<any>;
};
type Entry = { session: string; defaultContext: number; connection?: Connection; cancelled: boolean };

/** Each iframe gets its own isolated world and bridge, including cross-origin players. */
export class EmbeddedFrames {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  private rootFrame = "";
  private stopped = false;
  private ownsDebugger = false;
  private readonly debuggerApi: Debugger;
  private readonly target: WebviewTarget;
  private readonly create: CreateConnection;
  private readonly report: (error: unknown) => void;

  constructor(debuggerApi: Debugger, target: WebviewTarget, create: CreateConnection, report: (error: unknown) => void) {
    this.debuggerApi = debuggerApi;
    this.target = target;
    this.create = create;
    this.report = report;
  }

  async start(): Promise<void> {
    if (this.debuggerApi.isAttached()) throw new Error("영상 프레임 연결을 위해 열린 개발자 도구를 닫고 페이지를 새로고침해 주세요.");
    this.debuggerApi.attach("1.3");
    this.ownsDebugger = true;
    this.debuggerApi.on("message", this.onMessage);
    this.debuggerApi.on("detach", this.onDetach);
    const tree = await this.debuggerApi.sendCommand("Page.getFrameTree");
    if (this.stopped) return;
    this.rootFrame = tree.frameTree.frame.id;
    await this.enableSession("");
    await Promise.all([...this.pending]);
  }

  private async enableSession(session: string): Promise<void> {
    await this.debuggerApi.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session || undefined);
    if (!this.stopped) await this.debuggerApi.sendCommand("Runtime.enable", {}, session || undefined);
  }

  private track(work: Promise<void>): void {
    const pending = work.catch(error => { if (!this.stopped) this.report(error); }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  private readonly onMessage = (_event: unknown, method: string, params: any, session = "") => {
    if (this.stopped) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      this.track(this.enableSession(params.sessionId));
    } else if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      const frame = context?.auxData?.frameId;
      if (!context?.auxData?.isDefault || !frame || frame === this.rootFrame) return;
      const key = `${session}:${context.id}`;
      if (this.entries.has(key)) return;
      const entry: Entry = { session, defaultContext: context.id, cancelled: false };
      this.entries.set(key, entry);
      this.track(this.connect(frame, entry).catch(error => {
        if (entry.cancelled) return;
        this.entries.delete(key);
        throw error;
      }));
    } else if (method === "Runtime.executionContextDestroyed") {
      this.remove(`${session}:${params.executionContextId}`);
    } else if (method === "Runtime.executionContextsCleared" || method === "Target.detachedFromTarget") {
      const affected = method === "Target.detachedFromTarget" ? params.sessionId : session;
      for (const [key, entry] of this.entries) if (entry.session === affected) this.remove(key);
    }
  };

  private async connect(frameId: string, entry: Entry): Promise<void> {
    const session = entry.session || undefined;
    const world = await this.debuggerApi.sendCommand("Page.createIsolatedWorld", { frameId, worldName: "obsidian-immersive-video", grantUniveralAccess: false }, session);
    const executeJavaScript = async (code: string): Promise<unknown> => {
      if (this.stopped || entry.cancelled) throw new Error("영상 프레임 연결이 종료되었습니다.");
      const response = await this.debuggerApi.sendCommand("Runtime.evaluate", { expression: code, contextId: world.executionContextId, awaitPromise: true, returnByValue: true }, session);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result?.value;
    };
    const url = String(await executeJavaScript("location.href"));
    if (!isBridgePage(url) || this.stopped || entry.cancelled) return;
    const frameTarget: WebviewTarget = {
      getURL: () => entry.cancelled || this.stopped ? "about:blank" : url,
      executeJavaScript,
      addEventListener: (type, listener) => this.target.addEventListener(type, listener),
      removeEventListener: (type, listener) => this.target.removeEventListener(type, listener)
    };
    const connection = this.create(frameTarget);
    entry.connection = connection;
    try { await connection.start(); }
    catch (error) { await connection.dispose(); throw error; }
    if (this.stopped || entry.cancelled) await connection.dispose();
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.cancelled = true;
    this.entries.delete(key);
    if (entry.connection) void entry.connection.dispose().catch(this.report);
  }

  private readonly onDetach = () => {
    if (this.stopped) return;
    this.report(new Error("영상 프레임 연결이 해제되었습니다. 페이지를 새로고침해 주세요."));
    void this.dispose();
  };

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.debuggerApi.removeListener("message", this.onMessage);
    this.debuggerApi.removeListener("detach", this.onDetach);
    const connections = [...this.entries.values()].map(entry => { entry.cancelled = true; return entry.connection; });
    this.entries.clear();
    await Promise.all(connections.map(connection => connection?.dispose().catch(this.report)));
    if (this.ownsDebugger) {
      this.ownsDebugger = false;
      try { this.debuggerApi.detach(); } catch { /* the webview may already have closed */ }
    }
  }
}
