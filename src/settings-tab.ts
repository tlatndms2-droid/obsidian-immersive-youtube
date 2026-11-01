import { PluginSettingTab, Setting, Notice, type App, type Plugin } from "obsidian";
import { SCRIPT_VERSION } from "./script-store.ts";
import type { BridgeSettings, PreparationState } from "./settings-state.ts";

type SettingsOwner = Plugin & {
  settings: BridgeSettings;
  preparation: PreparationState;
  setAutoTranslate(enabled: boolean): Promise<void>;
  prepareScript(force?: boolean): Promise<void>;
  onPreparationChange(listener: () => void): () => void;
  openOfficialSettings(): Promise<void>;
};

export class BridgeSettingsTab extends PluginSettingTab {
  private readonly owner: SettingsOwner;
  private unsubscribe: (() => void) | undefined;

  constructor(app: App, owner: SettingsOwner) {
    super(app, owner);
    this.owner = owner;
  }

  display(): void {
    this.unsubscribe?.();
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("YouTube 한국어 자막 자동 번역")
      .setDesc("기본 웹뷰어에서 YouTube를 열면 Immersive Translate에서 선택한 번역 서비스로 자막을 표시합니다. 설정을 바꾼 뒤 이미 열린 YouTube 페이지는 새로고침해 주세요.")
      .addToggle(toggle => toggle.setValue(this.owner.settings.autoTranslate).onChange(async enabled => {
        toggle.setDisabled(true);
        try { await this.owner.setAutoTranslate(enabled); }
        catch { toggle.setValue(this.owner.settings.autoTranslate); new Notice("설정을 저장하지 못했습니다. 다시 시도해 주세요."); }
        finally { toggle.setDisabled(false); }
      }));
    new Setting(containerEl)
      .setName("Immersive Translate 공식 설정")
      .setDesc("공식 설정 화면에서 로그인하고, 비디오 자막에 사용할 번역 서비스와 AI를 선택합니다. Chrome 확장 설정과는 별도로 저장됩니다.")
      .addButton(button => button.setButtonText("공식 설정 열기").onClick(() => {
        void this.owner.openOfficialSettings().catch(() => new Notice("공식 설정 화면을 열지 못했습니다."));
      }));
    const status = new Setting(containerEl).setName("Immersive Translate 준비 상태");
    let refreshButton: { setDisabled(disabled: boolean): unknown; setButtonText(text: string): unknown };
    new Setting(containerEl)
      .setName("공식 스크립트 다시 받기")
      .setDesc(`검증한 ${SCRIPT_VERSION} 버전을 공식 주소에서 다시 받습니다. 최신 버전으로 변경하지 않으며, 실패하면 기존 파일을 보존합니다.`)
      .addButton(button => {
        refreshButton = button;
        button.setButtonText("다시 받기").onClick(() => { void this.owner.prepareScript(true); });
      });
    const update = () => {
      const state = this.owner.preparation;
      status.setDesc(state.message);
      refreshButton.setDisabled(state.phase === "loading");
      refreshButton.setButtonText(state.phase === "loading" ? "준비 중…" : "다시 받기");
    };
    update();
    this.unsubscribe = this.owner.onPreparationChange(update);
    containerEl.createEl("p", {
      text: "자동 번역을 끄면 새 번역 요청을 중단합니다. 이미 열린 페이지의 자막과 번역 버튼은 페이지를 새로고침하면 사라집니다.",
      cls: "setting-item-description"
    });
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
