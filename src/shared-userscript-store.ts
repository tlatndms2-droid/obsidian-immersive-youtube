export type StoreChange = { key: string; value?: unknown; deleted: boolean; source: string };

/** Uses the isolated Obsidian profile's browser storage, not a vault file. */
export class SharedUserscriptStore {
  private values: Record<string, unknown>;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly storageKey: string;
  private readonly listeners = new Set<(change: StoreChange) => void>();

  constructor(storage: Pick<Storage, "getItem" | "setItem">, storageKey: string) {
    this.storage = storage;
    this.storageKey = storageKey;
    const saved = storage.getItem(storageKey);
    const parsed = saved ? JSON.parse(saved) : {};
    this.values = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  snapshot(): Record<string, unknown> { return JSON.parse(JSON.stringify(this.values)); }
  isEmpty(): boolean { return Object.keys(this.values).length === 0; }

  seed(values: Record<string, unknown>): void {
    if (!this.isEmpty()) return;
    this.storage.setItem(this.storageKey, JSON.stringify(values));
    this.values = { ...values };
  }

  change(change: StoreChange): void {
    if (typeof change.key !== "string" || change.key.length > 300 || ["__proto__", "constructor", "prototype"].includes(change.key)) {
      throw new Error("지원하지 않는 설정 키입니다.");
    }
    if (change.deleted ? !Object.prototype.hasOwnProperty.call(this.values, change.key) :
        JSON.stringify(this.values[change.key]) === JSON.stringify(change.value)) return;
    const next = { ...this.values };
    if (change.deleted) delete next[change.key];
    else next[change.key] = change.value;
    this.storage.setItem(this.storageKey, JSON.stringify(next));
    this.values = next;
    for (const listener of this.listeners) listener(change);
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
