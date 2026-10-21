// codex-model-catalog.mjs 的类型面(与 mcp-tool-description-budget.d.mts 同理:.ts 侧的判据要真类型)。

export declare const PLATFORM_MODELS_ENV: 'GUGU_PLATFORM_MODELS'
export declare const CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW: 272000

export interface PlatformModelFact {
  id: string
  displayName: string
  contextWindow: number | null
  efforts: string[]
}

export declare function platformModelFacts(raw: string): PlatformModelFact[]
export declare function bundledEntryFor(
  id: string,
  bundled: ReadonlyArray<Record<string, unknown>>,
): (Record<string, unknown> & { slug: string }) | null
export declare function codexModelCatalog(
  facts: readonly PlatformModelFact[],
  bundled: ReadonlyArray<Record<string, unknown>>,
): {
  models: Array<Record<string, unknown> & {
    slug: string
    display_name: string
    context_window?: number
    max_context_window?: number
    supported_reasoning_levels: { effort: string; description: string }[]
  }>
}
export declare function writeCodexModelCatalog(
  env: Readonly<Record<string, string | undefined>>,
  /** stdout of the launcher's own `codex debug models --bundled`. */
  readBundledCatalog: () => Promise<string>,
): Promise<{ args: string[]; windowUnknown: string[]; dispose(): void }>
/** Remember a read only once it succeeded; a rejection clears the memo so the next caller reads again. */
export declare function memoizeSuccess<T>(read: () => Promise<T>): () => Promise<T>
