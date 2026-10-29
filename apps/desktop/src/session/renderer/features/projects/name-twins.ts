/**
 * 列表上与别的行同名的那些行(spec session-page-remote:同名时那一行带上路径区分,不同名不带)。
 * 桌面侧栏与手机「项目」页同一个判据:只比真画出来的行。
 */
export function nameTwinIds(rows: Iterable<{ id: string; name: string | null | undefined }>): Set<string> {
  const byName = new Map<string, string[]>();
  for (const { id, name } of rows) {
    if (name == null) continue;
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}
