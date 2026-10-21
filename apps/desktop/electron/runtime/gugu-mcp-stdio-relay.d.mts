// gugu-mcp-stdio-relay.mjs 的类型面(与 codex-fork-handoff.d.mts 同理:.ts 侧的判据要真类型)。

export declare function relayEnvSuffix(name: string): string

export declare function relayTarget(
  name: string,
  env?: Record<string, string | undefined>,
): { url: string; bearer: string | null } | null

export declare function offlineResponse(message: unknown): Record<string, unknown> | null
