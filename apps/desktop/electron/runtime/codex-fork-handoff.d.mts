// codex-fork-handoff.mjs 的类型面(与 codex-app-server-prompt.d.mts 同理:.ts 侧的判据要真类型)。

export interface CodexDeveloperMessageItem {
  type: 'message'
  role: 'developer'
  content: Array<{ type: 'input_text'; text: string }>
}

export declare function codexForkHandoffItems(developerInstructions: unknown): CodexDeveloperMessageItem[]
