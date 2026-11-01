export type BridgeSettings = { autoTranslate: boolean };
export type PreparationState = { phase: "idle" | "loading" | "ready" | "error"; message: string };

export function normalizeSettings(value: unknown): BridgeSettings {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { autoTranslate: typeof saved.autoTranslate === "boolean" ? saved.autoTranslate : true };
}
