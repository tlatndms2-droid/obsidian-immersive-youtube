import { request as httpsRequest } from "node:https";

// Only endpoints used by the verified official userscript and Google service.
const HOSTS = new Set([
  "config.immersivetranslate.com", "ai.immersivetranslate.com",
  "api2.immersivetranslate.com", "aigw1.immersivetranslate.com",
  "analytics.immersivetranslate.com", "www.google-analytics.com",
  "translate-pa.googleapis.com", "translate.googleapis.com",
  "immersivetranslate.com", "api.immersivetranslate.com", "app.immersivetranslate.com", "dash.immersivetranslate.com",
  "config.imtintl.com", "ai.imtintl.com", "api2.imtintl.com", "api2.imtedge.com", "aigw1.imtintl.com",
  "edge.microsoft.com", "api-edge.cognitive.microsofttranslator.com", "api.cognitive.microsofttranslator.com",
  "www.bing.com", "bing.com", "transmart.qq.com", "translate.yandex.net", "www2.deepl.com", "w.deepl.com",
  "api.deepl.com", "api-free.deepl.com", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "openrouter.ai", "api.deepseek.com", "api.groq.com", "api.x.ai", "dashscope.aliyuncs.com",
  "open.bigmodel.cn", "api.siliconflow.cn", "public-beta-api.siliconflow.cn", "ark.cn-beijing.volces.com",
  "hunyuan.tencentcloudapi.com", "api.papago-chrome.com", "fanyi.baidu.com", "api.fanyi.baidu.com",
  "open.volcengineapi.com", "translate.volcengine.com", "tmt.tencentcloudapi.com", "api.interpreter.caiyunai.com",
  "openapi.youdao.com", "aidemo.youdao.com", "api.niutrans.com", "mt.aliyuncs.com", "qianfan.baidubce.com",
  "api.platform.preferredai.jp"
]);
const MAX_BYTES = 8 * 1024 * 1024;

export type TranslationRequest = {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  timeout: number;
};
export type TranslationResponse = {
  status: number;
  statusText: string;
  responseText: string;
  responseHeaders: string;
  finalUrl: string;
  readyState: number;
};

export function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) ||
      url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("허용되지 않은 번역 서버 요청입니다.");
  }
  return url;
}

export function parseRequest(value: unknown): TranslationRequest {
  if (!value || typeof value !== "object") throw new Error("잘못된 번역 요청입니다.");
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.id) || (input.id as number) < 1 || typeof input.url !== "string") {
    throw new Error("잘못된 번역 요청 번호 또는 주소입니다.");
  }
  allowedUrl(input.url);
  const method = String(input.method || "GET").toUpperCase();
  if (!["GET", "POST", "HEAD"].includes(method)) throw new Error("지원하지 않는 요청 방식입니다.");
  const headers: Record<string, string> = {};
  if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value !== "string" || /[\r\n]/.test(key + value)) throw new Error("잘못된 요청 헤더입니다.");
      if (!["host", "connection", "content-length"].includes(key.toLowerCase())) headers[key] = value;
    }
  }
  if (input.data !== undefined && typeof input.data !== "string") throw new Error("지원하지 않는 요청 본문입니다.");
  if (typeof input.data === "string" && Buffer.byteLength(input.data) > 1024 * 1024) {
    throw new Error("번역 요청이 너무 큽니다.");
  }
  return {
    id: input.id as number, url: input.url, method, headers,
    data: input.data as string | undefined,
    timeout: Math.max(500, Math.min(Number(input.timeout) || 20000, 30000))
  };
}

export function sendTranslation(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
  const send = (current: TranslationRequest, redirects = 0): Promise<TranslationResponse> => {
    const url = allowedUrl(current.url);
    return new Promise((resolve, reject) => {
      const headers = { ...current.headers };
      if (current.data !== undefined) headers["Content-Length"] = String(Buffer.byteLength(current.data));
      const req = httpsRequest(url, { method: current.method, headers, signal }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume();
          if (redirects >= 5) { reject(new Error("번역 서버의 주소 이동이 너무 많습니다.")); return; }
          try {
            const next = allowedUrl(new URL(res.headers.location, url).href);
            const headers = { ...current.headers };
            if (next.origin !== url.origin) {
              for (const key of Object.keys(headers)) {
                if (["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())) delete headers[key];
              }
            }
            const get = res.statusCode === 303 || ([301, 302].includes(res.statusCode!) && current.method === "POST");
            resolve(send({ ...current, url: next.href, headers, method: get ? "GET" : current.method, data: get ? undefined : current.data }, redirects + 1));
          } catch (error) { reject(error); }
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) { req.destroy(new Error("번역 서버 응답이 너무 큽니다.")); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({
          status: res.statusCode || 0, statusText: res.statusMessage || "",
          responseText: Buffer.concat(chunks).toString("utf8"),
          responseHeaders: Object.entries(res.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n"),
          finalUrl: url.href, readyState: 4
        }));
      });
      req.on("error", reject);
      if (current.data) req.write(current.data);
      req.end();
    });
  };
  return send(request);
}
