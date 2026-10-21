export {
  applySessionRuntimeCommand,
  clearRuntimeVersionProbeCache,
  assertSessionRuntimeCompatible,
  assertSessionSurfaceDeclared,
  resolveSessionRuntimeCompatible,
  SessionRuntimeCompatibilityError,
  type SessionRuntimeCompatibilityErrorCode,
  type SessionRuntimeResolution,
} from '@gugu/session-core/agents/plugins';

/**
 * 把将要 spawn 的 `NodeJS.ProcessEnv` 交给版本探针:探针要一份确定的键值(值可以是 undefined 的键不算数)。
 * codex app-server 与 opencode serve 两条腿共用这一份,❌ 各写一遍。
 */
export function versionProbeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
