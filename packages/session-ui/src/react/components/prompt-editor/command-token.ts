/**
 * 编辑器这一侧对命令 token 只做两件事:**兜个底**、**拆开显示**。
 *
 * token 的真身由宿主给(`CommandItem.token`)——「名字自带 sigil 就是它自己、裸名才配 `/`」
 * 是 ACP 的领域规则,住在 `@gugu/session-core/acp/commands`。这一层**不许**知道那条规则,
 * 也不许按厂商分叉:它只负责把拿到的字符串原样送出去,以及按首字符切成
 * 「前缀符号 + 可读名」给芯片画。
 */

/** 宿主没给 token 时的兜底 —— 只服务不经 ACP 的调用方。 */
export function fallbackToken(name: string): string {
  return name ? `/${name}` : '';
}

/**
 * token 拆成前缀符号与可读名。显示与序列化必须读同一个字符串,
 * 否则界面上写着 `$foo`、发出去的却是 `/foo`。
 */
export function splitToken(token: string): { sigil: string; label: string } {
  return { sigil: token.slice(0, 1), label: token.slice(1) };
}
