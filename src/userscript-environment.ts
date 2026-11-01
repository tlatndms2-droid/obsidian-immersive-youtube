type EnvironmentOptions = { channel: string; version: string; values?: Record<string, unknown> };

// Self-contained: serialized into the web page, without Node or vault access.
export function installUserscriptEnvironment(options: EnvironmentOptions): void {
  const page = globalThis as any;
  const storagePrefix = "immersive-youtube-gm:";
  const pending = new Map<number, any>();
  const listeners = new Map<number, { key: string; callback: Function }>();
  let nextId = 1;
  let stopped = false;
  const values: Record<string, any> = Object.create(null);
  if (options.values) Object.assign(values, options.values);
  else for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(storagePrefix)) continue;
    try { values[key.slice(storagePrefix.length)] = JSON.parse(localStorage.getItem(key)!); } catch { /* invalid legacy value */ }
  }
  const getStoredValue = (key: string, fallback?: unknown) =>
    Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined ? JSON.parse(JSON.stringify(values[key])) : fallback;
  const getValue = (key: string, fallback?: unknown) => {
    const value = getStoredValue(key, fallback);
    // The pinned script expects the old desktop embed controls. YouTube also
    // serves embeds with the new player-controls-bottom-right layout. Extend
    // the official button's mount selectors in this document's read-only copy.
    // Never persist these compatibility selectors into the user's shared config.
    if (key === "buildinConfig" && value && typeof value === "object") {
      try {
        const url = new URL(location.href);
        if (["www.youtube.com", "www.youtube-nocookie.com"].includes(url.hostname) && url.pathname.startsWith("/embed/")) {
          for (const rule of Array.isArray(value.rules) ? value.rules : []) {
            if (!["youtube", "youtube-subtitle"].includes(rule.id)) continue;
            const subtitle = rule["subtitleRule.add"] || rule.subtitleRule;
            const quick = subtitle?.quickButtonRule;
            if (!quick?.appendSelector) continue;
            quick.appendSelector += ", .player-controls-bottom-right";
            quick.insertBeforeSelector = [quick.insertBeforeSelector, ".ytwPlayerBottomControlsFullscreenButtonWrapper"].filter(Boolean).join(", ");
            quick.injectedGlobalCSS = (quick.injectedGlobalCSS || "") + ".player-controls-bottom-right .immersive-translate-quick-button-container {display:inline-flex;align-items:center;height:40px;position:relative;font-size:12px;margin-right:8px;}";
          }
        }
      } catch { /* Non-browser test environments and malformed config need no adaptation. */ }
    }
    return value;
  };
  const notify = (key: string, before: unknown, after: unknown, remote = false) => {
    for (const listener of listeners.values()) {
      if (listener.key === key) {
        try { listener.callback(key, before, after, remote); } catch { /* one listener must not stop others */ }
      }
    }
  };
  const setValue = (key: string, value: unknown) => {
    const before = getStoredValue(key);
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    values[key] = value;
    if (!options.values) localStorage.setItem(storagePrefix + key, JSON.stringify(value));
    emit({ action: "storage", key, value });
    notify(key, before, value);
  };
  const deleteValue = (key: string) => {
    const before = getValue(key);
    if (!Object.prototype.hasOwnProperty.call(values, key)) return;
    delete values[key];
    if (!options.values) localStorage.removeItem(storagePrefix + key);
    emit({ action: "storage-delete", key });
    notify(key, before, undefined);
  };
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(storagePrefix)) return;
    try { notify(event.key.slice(storagePrefix.length), JSON.parse(event.oldValue || "null"), JSON.parse(event.newValue || "null"), true); } catch { /* malformed external storage */ }
  };
  addEventListener("storage", onStorage);
  const emit = (value: object) => console.info(options.channel + JSON.stringify(value));
  const finish = (id: number, result: any) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    const details = item.details;
    if (result.error) {
      const callback = result.type === "timeout" ? details.ontimeout : result.type === "abort" ? details.onabort : details.onerror;
      callback?.(result);
    } else {
      result.response = details.responseType === "json" ? (() => { try { return JSON.parse(result.responseText); } catch { return null; } })() : result.responseText;
      details.onreadystatechange?.(result);
      details.onload?.(result);
    }
    details.onloadend?.(result);
  };
  const xhr = (details: any) => {
    if (stopped) { details.onerror?.({ error: "플러그인 연결이 종료되었습니다." }); return { abort() {} }; }
    const id = nextId++;
    const timeout = Math.max(500, Math.min(Number(details.timeout) || 20000, 30000));
    const timer = setTimeout(() => {
      emit({ action: "abort", id });
      finish(id, { error: "번역 요청 시간이 초과되었습니다.", type: "timeout" });
    }, timeout);
    pending.set(id, { details, timer });
    const headers = { ...details.headers };
    if (typeof navigator !== "undefined" && !Object.keys(headers).some(key => key.toLowerCase() === "user-agent")) {
      headers["User-Agent"] = navigator.userAgent;
    }
    emit({ action: "request", id, url: details.url, method: details.method || "GET", headers, data: details.data, timeout });
    return { abort() { emit({ action: "abort", id }); finish(id, { error: "번역 요청을 취소했습니다.", type: "abort" }); } };
  };
  const addElement = (...args: any[]) => {
    let parent: any, tag: string, attributes: Record<string, string>;
    if (typeof args[0] === "string") { [tag, attributes] = args; parent = document.head || document.documentElement; }
    else [parent, tag, attributes] = args;
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === "textContent") element.textContent = value;
      else element.setAttribute(key, value);
    }
    parent.appendChild(element);
    return element;
  };
  const info = { script: { name: "Immersive Translate", version: options.version }, scriptHandler: "Tampermonkey", version: "5.3", platform: { browserName: "chrome" } };
  const api = {
    GM_info: info, unsafeWindow: globalThis,
    GM_getValue: getValue, GM_setValue: setValue, GM_deleteValue: deleteValue,
    GM_listValues: () => Object.keys(values),
    GM_xmlhttpRequest: xhr, GM_addElement: addElement,
    GM_addStyle: (text: string) => addElement("style", { textContent: text }),
    GM_registerMenuCommand: () => 0,
    GM_openInTab: (value: string) => { emit({ action: "open-tab", url: new URL(value, location.href).href }); return { close() {} }; },
    GM_addValueChangeListener: (key: string, callback: Function) => { const id = nextId++; listeners.set(id, { key, callback }); return id; },
    GM_removeValueChangeListener: (id: number) => listeners.delete(id)
  };
  Object.assign(page, api);
  page.GM = {
    info, getValue: async (key: string, fallback?: unknown) => getValue(key, fallback),
    setValue: async (key: string, value: unknown) => setValue(key, value),
    deleteValue: async (key: string) => deleteValue(key), listValues: async () => api.GM_listValues(),
    xmlHttpRequest: xhr, addElement, addStyle: api.GM_addStyle, registerMenuCommand: api.GM_registerMenuCommand,
    openInTab: api.GM_openInTab, addValueChangeListener: api.GM_addValueChangeListener,
    removeValueChangeListener: api.GM_removeValueChangeListener
  };
  page.__immersiveYouTubeBridge = {
    channel: options.channel,
    reply: finish,
    updateStorage(key: string, value: unknown, deleted = false) {
      const before = getValue(key);
      if (deleted) delete values[key]; else values[key] = value;
      notify(key, before, deleted ? undefined : value, true);
    },
    dispose() {
      stopped = true;
      removeEventListener("storage", onStorage);
      for (const id of [...pending.keys()]) finish(id, { error: "플러그인 연결이 종료되었습니다.", type: "abort" });
      listeners.clear();
    }
  };
  const user = getValue("fullLocalUserConfig", {});
  setValue("fullLocalUserConfig", {
    ...user, targetLanguage: user.targetLanguage ?? "ko",
    translationService: user.translationService ?? "google",
    subtitleTranslateService: user.subtitleTranslateService ?? "inherit",
    subtitle: { preTranslation: true, humanSubtitlesPreferred: false, ...user.subtitle,
      youtube: { autoEnableSubtitle: true, ...user.subtitle?.youtube } }
  });
}

export function environmentSource(channel: string, version: string, values?: Record<string, unknown>): string {
  return `(${installUserscriptEnvironment.toString()})(${JSON.stringify({ channel, version, values })})`;
}
