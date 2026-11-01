import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// This is the official userscript tested in the isolated Obsidian Sandbox.
// Its implementation is downloaded at runtime, never bundled in this plugin.
export const SCRIPT_VERSION = "1.34.4";
export const SCRIPT_SHA256 = "b90582707852e28562498dc25697bf6168d30eda6a9a8c269b0018eaf4c1682d";
export const SCRIPT_URLS = [
  "https://github.com/immersive-translate/immersive-translate/releases/download/v1.34.4/immersive-translate.user.js",
  "https://download.immersivetranslate.com/immersive-translate.user.js"
] as const;

export type Download = (url: string) => Promise<Uint8Array>;
export type PreparedScript = {
  path: string;
  version: string;
  source: "cache" | "download";
};

export function verifyScript(bytes: Uint8Array): void {
  if (bytes.byteLength > 12 * 1024 * 1024) {
    throw new Error("공식 스크립트의 크기가 예상 범위를 초과했습니다.");
  }
  const header = Buffer.from(bytes.subarray(0, 16000)).toString("utf8");
  if (!header.startsWith("// ==UserScript==") ||
      !new RegExp(`^// @version\\s+${SCRIPT_VERSION.replaceAll(".", "\\.")}\\s*$`, "m").test(header)) {
    throw new Error(`확인된 Immersive Translate ${SCRIPT_VERSION} 스크립트가 아닙니다.`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== SCRIPT_SHA256) {
    throw new Error("공식 스크립트가 검증한 파일과 다릅니다. 자동으로 실행하지 않습니다.");
  }
}

export class ScriptStore {
  private pending: Promise<PreparedScript> | undefined;
  private readonly directory: string;
  private readonly download: Download;
  readonly scriptPath: string;

  constructor(directory: string, download: Download) {
    this.directory = directory;
    this.download = download;
    this.scriptPath = join(directory, `immersive-translate-${SCRIPT_VERSION}.user.js`);
  }

  ensure(forceDownload = false): Promise<PreparedScript> {
    if (!this.pending) {
      this.pending = this.prepare(forceDownload).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async prepare(forceDownload: boolean): Promise<PreparedScript> {
    if (!forceDownload) try {
      verifyScript(await readFile(this.scriptPath));
      return { path: this.scriptPath, version: SCRIPT_VERSION, source: "cache" };
    } catch (error) {
      // Only a missing or invalid cache is recoverable through a new download.
      if ((error as NodeJS.ErrnoException).code &&
          (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let lastError: unknown;
    for (const url of SCRIPT_URLS) {
      let bytes: Uint8Array;
      try {
        bytes = await this.download(url);
        verifyScript(bytes);
      } catch (error) {
        lastError = error;
        continue;
      }

      await mkdir(this.directory, { recursive: true });
      const temporaryPath = `${this.scriptPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, bytes, { flag: "wx" });
        await rename(temporaryPath, this.scriptPath);
      } finally {
        await unlink(temporaryPath).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return { path: this.scriptPath, version: SCRIPT_VERSION, source: "download" };
    }
    throw new Error(`Immersive Translate 준비 실패: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}
