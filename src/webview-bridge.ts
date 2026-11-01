import { randomUUID } from "node:crypto";
import { environmentSource } from "./userscript-environment.ts";
import { parseRequest, sendTranslation, type TranslationRequest, type TranslationResponse } from "./translation-transport.ts";
import { SCRIPT_VERSION, verifyScript } from "./script-store.ts";
import { SharedUserscriptStore } from "./shared-userscript-store.ts";

export const OFFICIAL_SETTINGS_URL = "https://dash.immersivetranslate.com/#subtitle";
export function isOfficialSettingsPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      ((url.hostname === "dash.immersivetranslate.com" && ["/", "/auth-done/"].includes(url.pathname)) ||
       (url.hostname === "immersivetranslate.com" && (url.pathname.startsWith("/accounts/") || url.pathname === "/profile/")));
  } catch { return false; }
}
export function isBridgePage(value: string): boolean { return isYouTubePage(value) || isOfficialSettingsPage(value); }

export type WebviewTarget = {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
};
type Transport = (request: TranslationRequest, signal: AbortSignal) => Promise<TranslationResponse>;

export function isYouTubePage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export class WebviewBridge {
  private readonly channel = `__IMT_BRIDGE_${randomUUID()}__`;
  private readonly active = new Map<number, AbortController>();
  private stopped = false;
  private started = false;
  private readonly target: WebviewTarget;
  private readonly transport: Transport;
  private readonly store?: SharedUserscriptStore;
  private readonly openTab?: (url: string) => void;
  private unsubscribe?: () => void;

  constructor(target: WebviewTarget, transport: Transport = sendTranslation, store?: SharedUserscriptStore, openTab?: (url: string) => void) {
    this.target = target;
    this.transport = transport;
    this.store = store;
    this.openTab = openTab;
  }

  private isYouTube(): boolean {
    try { return isBridgePage(this.target.getURL()); } catch { return false; }
  }

  private readonly onConsole = (event: { message?: string }) => {
    if (this.stopped || !this.isYouTube() || !event.message?.startsWith(this.channel)) return;
    let value: any;
    try { value = JSON.parse(event.message.slice(this.channel.length)); } catch { return; }
    if (value?.action === "open-tab") {
      if (typeof value.url === "string" && isOfficialSettingsPage(value.url)) this.openTab?.(value.url);
      return;
    }
    if (value?.action === "storage" || value?.action === "storage-delete") {
      try { this.store?.change({ key: value.key, value: value.value, deleted: value.action === "storage-delete", source: this.channel }); }
      catch { /* Keep values out of logs: settings may contain account credentials. */ }
      return;
    }
    if (value?.action === "abort" && Number.isSafeInteger(value.id)) { this.active.get(value.id)?.abort(); return; }
    if (value?.action !== "request") return;
    let request: TranslationRequest;
    try {
      request = parseRequest(value);
      if (this.active.has(request.id)) return;
      if (this.active.size >= 32) throw new Error("동시에 처리 중인 번역 요청이 너무 많습니다.");
    } catch (error) {
      if (Number.isSafeInteger(value.id)) void this.reply(value.id, { error: error instanceof Error ? error.message : "잘못된 번역 요청입니다." });
      return;
    }
    const controller = new AbortController();
    this.active.set(request.id, controller);
    const timer = setTimeout(() => controller.abort(), request.timeout);
    void this.transport(request, controller.signal)
      .then(response => this.reply(request.id, response))
      .catch(error => this.reply(request.id, { error: controller.signal.aborted ? "번역 요청이 취소되거나 시간이 초과되었습니다." : error instanceof Error ? error.message : "번역 서버 연결 실패" }))
      .finally(() => { clearTimeout(timer); this.active.delete(request.id); });
  };

  private async reply(id: number, result: object): Promise<void> {
    if (this.stopped || !this.isYouTube()) return;
    const code = `(()=>{const b=globalThis.__immersiveYouTubeBridge;if(b?.channel===${JSON.stringify(this.channel)})b.reply(${id},${JSON.stringify(result)})})()`;
    await this.target.executeJavaScript(code).catch(() => { /* page may have closed */ });
  }

  async start(script: Uint8Array): Promise<void> {
    if (this.started || this.stopped) throw new Error("이미 실행했거나 종료된 연결입니다.");
    if (!this.isYouTube()) throw new Error("YouTube 웹뷰어에서만 실행할 수 있습니다.");
    verifyScript(script);
    this.started = true;
    this.target.addEventListener("console-message", this.onConsole);
    try {
      if (this.store?.isEmpty() && isYouTubePage(this.target.getURL())) {
        const legacy = await this.target.executeJavaScript(`(()=>{const out=Object.create(null);for(const key of Object.keys(localStorage)){if(key.startsWith('immersive-youtube-gm:')){try{out[key.slice(21)]=JSON.parse(localStorage.getItem(key))}catch{}}}return out})()`);
        if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) this.store.seed(legacy as Record<string, unknown>);
      }
      if (this.stopped || !this.isYouTube()) return;
      this.unsubscribe = this.store?.subscribe(change => {
        if (change.source === this.channel || this.stopped || !this.isYouTube()) return;
        void this.target.executeJavaScript(`(()=>{const b=globalThis.__immersiveYouTubeBridge;if(b?.channel===${JSON.stringify(this.channel)})b.updateStorage(${JSON.stringify(change.key)},${JSON.stringify(change.value) ?? "undefined"},${change.deleted})})()`).catch(() => {});
      });
      // One execution prevents a reload between environment setup and script injection.
      await this.target.executeJavaScript(`${environmentSource(this.channel, SCRIPT_VERSION, this.store?.snapshot())};\n${Buffer.from(script).toString("utf8")}`);
    } catch (error) { await this.dispose(); throw error; }
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.target.removeEventListener("console-message", this.onConsole);
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    if (this.started && this.isYouTube()) {
      await this.target.executeJavaScript(`(()=>{const b=globalThis.__immersiveYouTubeBridge;if(b?.channel===${JSON.stringify(this.channel)})b.dispose()})()`).catch(() => {});
    }
  }
}
