export interface PluginFs {
  /**
   * Write policy for harness MCP config files. `assertWritable` is a WHITELIST:
   * only 'owned' (gugu-owned run-scoped files) may write; 'user-config' AND
   * undefined are rejected — an fs that never declared a write scope must not be
   * able to rewrite user configuration by omission (#4595 fail-open).
   *
   * ⚠️ 曾经还有一档 `'session-owned'`(#4589):那是**专为**会话物化写入器开的豁免,而那个
   *    写入器是 qwen 终端腿把 MCP 合并进用户 `~/.qwen/settings.json` 的唯一入口。2026-09-03
   *    qwen 改走 run-scoped 的系统级 settings 副本(#4834)之后,那个写入器整条下线,这一档
   *    也随之删除 —— 守卫的对象没了、守卫还留着,只会在某天被另一家顺手捡去当合法入口。
   */
  readonly mcpWriteScope?: 'user-config' | 'owned';
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}
