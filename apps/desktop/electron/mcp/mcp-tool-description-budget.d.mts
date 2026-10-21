// mcp-tool-description-budget.mjs 的类型面(与 codex-model-catalog.d.mts 同一做法:给真类型,不压成 any)。
export declare const CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET: number
export declare const TOOL_OUTPUT_BYTE_BUDGET: number
export declare const GUGU_LISTED_TOOLS_TOKEN_BUDGET: number
export declare function assertMcpToolDescriptionWithinBudget(name: string, description: string | undefined): void
