import { FileSystemAdapter, Notice, Plugin, requestUrl } from "obsidian";
import { join, relative, resolve, isAbsolute } from "node:path";
import { ScriptStore, SCRIPT_VERSION, verifyScript, type PreparedScript } from "./script-store.ts";
import { readFile } from "node:fs/promises";
import { WebviewBridge } from "./webview-bridge.ts";
import { WebviewAutoStart } from "./webview-autostart.ts";
import { normalizeSettings, type BridgeSettings, type PreparationState } from "./settings-state.ts";
import { BridgeSettingsTab } from "./settings-tab.ts";
import { createHash } from "node:crypto";
import { SharedUserscriptStore } from "./shared-userscript-store.ts";
import { isOfficialSettingsPage, OFFICIAL_SETTINGS_URL } from "./webview-bridge.ts";

export default class ImmersiveYouTubeBridge extends Plugin {
  settings: BridgeSettings = normalizeSettings(undefined);
  preparation: PreparationState = { phase: "idle", message: "준비 대기 중입니다." };
  preparedScript: PreparedScript | undefined;
  private script: Uint8Array | undefined;
  private store: ScriptStore | undefined;
  private pendingPreparation: Promise<void> | undefined;
  private readonly preparationListeners = new Set<() => void>();
  private stopped = false;
  private autostart: WebviewAutoStart | undefined;
  private sharedStore: SharedUserscriptStore | undefined;

  async onload(): Promise<void> {
    this.stopped = false;
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new BridgeSettingsTab(this.app, this));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.synchronizeRuntime()));
    this.app.workspace.onLayoutReady(() => this.synchronizeRuntime());
    await this.prepareScript();
  }

  private createStore(): ScriptStore {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !this.manifest.dir) {
      throw new Error("플러그인 설치 폴더를 확인할 수 없습니다. 데스크톱 Obsidian이 필요합니다.");
    }
    const vaultRoot = adapter.getBasePath();
    const pluginRoot = resolve(vaultRoot, this.manifest.dir);
    const pluginRelative = relative(vaultRoot, pluginRoot);
    if (isAbsolute(pluginRelative) || pluginRelative === ".." || pluginRelative.startsWith("..\\") || pluginRelative.startsWith("../")) {
      throw new Error("플러그인 경로가 보관함 외부를 가리킵니다.");
    }
    return new ScriptStore(join(pluginRoot, "vendor"), async url => {
      const response = await requestUrl({ url, method: "GET", throw: true });
      if (response.status !== 200) throw new Error(`다운로드 응답: ${response.status}`);
      return new Uint8Array(response.arrayBuffer);
    });
  }

  prepareScript(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.pendingPreparation) {
      this.pendingPreparation = this.prepare(force).finally(() => { this.pendingPreparation = undefined; });
    }
    return this.pendingPreparation;
  }

  private async prepare(force: boolean): Promise<void> {
    this.setPreparation({ phase: "loading", message: force ? "공식 스크립트를 다시 받는 중입니다…" : "공식 스크립트를 확인하고 준비하는 중입니다…" });
    try {
      this.store ??= this.createStore();
      const prepared = await this.store.ensure(force);
      const script = await readFile(prepared.path);
      verifyScript(script);
      if (this.stopped) return;
      this.preparedScript = prepared;
      this.script = script;
      if (!this.sharedStore) {
        const vaultKey = createHash("sha256").update((this.app.vault.adapter as FileSystemAdapter).getBasePath()).digest("hex").slice(0, 20);
        this.sharedStore = new SharedUserscriptStore(window.localStorage, `immersive-youtube-shared:${vaultKey}`);
      }
      this.setPreparation({ phase: "ready", message: `준비 완료 · Immersive Translate ${SCRIPT_VERSION} · ${prepared.source === "cache" ? "저장된 파일 확인" : "공식 파일 다운로드 완료"}` });
      this.synchronizeRuntime();
    } catch (error) {
      if (this.stopped) return;
      console.error("[Immersive YouTube Bridge]", error);
      const reason = error instanceof Error ? error.message : "공식 스크립트 준비에 실패했습니다.";
      this.setPreparation({ phase: "error", message: `${reason}${this.script ? " 기존에 준비한 파일로 자동 번역을 계속 사용할 수 있습니다." : " ‘다시 받기’를 눌러 재시도해 주세요."}` });
      new Notice(reason);
    }
  }

  async setAutoTranslate(enabled: boolean): Promise<void> {
    const next = { autoTranslate: enabled };
    await this.saveData(next);
    if (this.stopped) return;
    this.settings = next;
    this.autostart?.stop();
    this.autostart = undefined;
    this.synchronizeRuntime();
  }

  async openOfficialSettings(url = OFFICIAL_SETTINGS_URL): Promise<void> {
    if (!isOfficialSettingsPage(url)) return;
    if (!this.script) await this.prepareScript();
    if (!this.script || this.stopped) return;
    if (!(this.app as any).internalPlugins?.plugins?.webviewer?.enabled) {
      new Notice("코어 플러그인의 ‘웹 뷰어’를 먼저 켜 주세요.");
      return;
    }
    (this.app as any).setting?.close();
    const existing = this.app.workspace.getLeavesOfType("webviewer").find(leaf => isOfficialSettingsPage(String(leaf.view.getState().url || "")));
    const leaf = existing || this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "webviewer", active: true, state: { url, title: "Immersive Translate 설정", navigate: true } });
    this.synchronizeRuntime();
  }

  private synchronizeRuntime(): void {
    if (this.stopped || !this.script) {
      this.autostart?.stop();
      this.autostart = undefined;
      return;
    }
    if (!this.autostart) {
      const script = this.script;
      this.autostart = new WebviewAutoStart(target => {
        const bridge = new WebviewBridge(target, undefined, this.sharedStore, url => { void this.openOfficialSettings(url); });
        return { start: () => bridge.start(script), dispose: () => bridge.dispose() };
      }, error => {
        console.error("[Immersive YouTube Bridge] 자동 연결 실패", error);
        if (!this.stopped) new Notice("YouTube 자막 자동 연결에 실패했습니다. 페이지를 새로고침해 주세요.");
      });
    }
    this.autostart.synchronize(this.app.workspace.getLeavesOfType("webviewer")
      .filter(leaf => this.settings.autoTranslate || isOfficialSettingsPage(String(leaf.view.getState().url || "")))
      .map(leaf => leaf.view.containerEl));
  }

  onPreparationChange(listener: () => void): () => void {
    this.preparationListeners.add(listener);
    return () => { this.preparationListeners.delete(listener); };
  }

  private setPreparation(state: PreparationState): void {
    this.preparation = state;
    for (const listener of this.preparationListeners) listener();
  }

  onunload(): void {
    this.stopped = true;
    this.autostart?.stop();
    this.autostart = undefined;
    this.preparedScript = undefined;
    this.script = undefined;
    this.preparationListeners.clear();
  }
}
