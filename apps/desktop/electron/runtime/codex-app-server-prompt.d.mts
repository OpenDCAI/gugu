// codex-app-server-prompt.mjs 的类型面(与 mcp-tool-description-budget.d.mts 同理:.ts 侧的判据要真类型)。

export interface CodexTextInputItem {
  type: 'text'
  text: string
  text_elements: unknown[]
}

export interface CodexImageInputItem {
  type: 'image'
  url: string
}

export type CodexInputItem = CodexTextInputItem | CodexImageInputItem

export declare function joinPromptText(blocks: unknown): string
export declare function promptInputItems(prompt: unknown): CodexInputItem[]
