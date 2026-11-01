import { isBridgePage, type WebviewTarget } from "./webview-bridge.ts";

export type Connection = { start(): Promise<void>; dispose(): Promise<void> };
export type CreateConnection = (target: WebviewTarget) => Connection;

/** One document per webview. Same-document navigation keeps the existing official script. */
class TargetSession {
  private connection: Connection | undefined;
  private generation = 0;
  private stopped = false;
  private readonly listeners = new Map<string, (event: any) => void>();
  private readonly target: WebviewTarget;
  private readonly create: CreateConnection;
  private readonly report: (error: unknown) => void;

  constructor(target: WebviewTarget, create: CreateConnection, report: (error: unknown) => void) {
    this.target = target;
    this.create = create;
    this.report = report;
    this.listen("did-start-navigation", event => {
      if (event.isMainFrame === false || event.isInPlace === true || event.isSameDocument === true) return;
      this.invalidate();
    });
    this.listen("dom-ready", () => { void this.connect(); });
    this.listen("did-navigate-in-page", event => {
      if (event.isMainFrame === false) return;
      // The official script handles same-document content changes. Re-injecting would duplicate it.
      if (!this.isSupportedPage()) this.invalidate();
      else void this.connect();
    });
    this.listen("render-process-gone", () => this.invalidate());
    this.listen("destroyed", () => this.stop());
    // Existing tabs may have emitted dom-ready before the plugin was enabled.
    void this.probeExistingDocument();
  }

  private listen(type: string, callback: (event: any) => void): void {
    this.listeners.set(type, callback);
    this.target.addEventListener(type, callback);
  }

  private isSupportedPage(): boolean {
    try { return isBridgePage(this.target.getURL()); } catch { return false; }
  }

  private async probeExistingDocument(): Promise<void> {
    const generation = this.generation;
    try {
      if (!this.isSupportedPage()) return;
      const ready = await this.target.executeJavaScript("document.readyState");
      if (!this.stopped && generation === this.generation && (ready === "interactive" || ready === "complete")) {
        await this.connect();
      }
    } catch { /* A not-yet-attached webview will emit dom-ready later. */ }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connection || !this.isSupportedPage()) return;
    const generation = this.generation;
    const connection = this.create(this.target);
    this.connection = connection;
    try {
      await connection.start();
      if (this.stopped || generation !== this.generation) await connection.dispose();
    } catch (error) {
      if (this.connection === connection) this.connection = undefined;
      await connection.dispose();
      if (!this.stopped && generation === this.generation) this.report(error);
    }
  }

  private invalidate(): void {
    this.generation++;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) void connection.dispose().catch(this.report);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.invalidate();
    for (const [type, listener] of this.listeners) this.target.removeEventListener(type, listener);
    this.listeners.clear();
  }
}

export class WebviewAutoStart {
  private readonly sessions = new Map<WebviewTarget, TargetSession>();
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private stopped = false;
  private readonly create: CreateConnection;
  private readonly report: (error: unknown) => void;

  constructor(create: CreateConnection, report: (error: unknown) => void) {
    this.create = create;
    this.report = report;
  }

  /** Called only with containers belonging to Obsidian's core webviewer views. */
  synchronize(containers: HTMLElement[]): void {
    if (this.stopped) return;
    const roots = new Set(containers);
    for (const [root, observer] of this.observers) {
      if (!roots.has(root)) { observer.disconnect(); this.observers.delete(root); }
    }
    for (const root of roots) {
      if (this.observers.has(root)) continue;
      const Observer = (root.ownerDocument.defaultView as Window & typeof globalThis | null)?.MutationObserver;
      if (!Observer) continue;
      const observer = new Observer(() => this.scan());
      observer.observe(root, { childList: true, subtree: true });
      this.observers.set(root, observer);
    }
    this.scan();
  }

  private scan(): void {
    if (this.stopped) return;
    const targets = new Set<WebviewTarget>();
    for (const root of this.observers.keys()) {
      if (!root.isConnected) continue;
      for (const target of Array.from(root.querySelectorAll("webview"))) targets.add(target as unknown as WebviewTarget);
    }
    this.synchronizeTargets(targets);
  }

  /** Separate lifecycle layer so navigation races can be tested without Electron. */
  synchronizeTargets(targets: Iterable<WebviewTarget>): void {
    if (this.stopped) return;
    const current = new Set(targets);
    for (const [target, session] of this.sessions) {
      if (!current.has(target)) { session.stop(); this.sessions.delete(target); }
    }
    for (const target of current) {
      if (!this.sessions.has(target)) this.sessions.set(target, new TargetSession(target, this.create, this.report));
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
