// 生成脚本里的文案放在 String.raw 之外、按 JSON 插进去:raw 段里的非 ASCII 会让整份主进程 bundle 按双字节常驻(#655)。
const DENY_PANEL_LOG = '面板变更记录由系统维护，不能覆盖、删除或自行撤销。';
const DENY_DELETED = '这条记忆或资料已被主人删除，不再作为依据；不能读取或重建原文件。';
const DENY_UNVERIFIED = '无法核实主人已删除的资料，本次工具调用未执行，请重试。';

/** Native history stays intact. Revoked files are denied at the actual tool
 * boundary, even if an old turn or a stale index still names their paths. */
export function assistantPanelRevocationHook(statePath: string): string {
  return `const statePath = ${JSON.stringify(statePath)};
${String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
const deny = reason => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} }) + '\n');
async function main() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (event.hook_event_name !== 'PreToolUse' || !['Read','Write','Edit'].includes(event.tool_name)) return;
  if (typeof event.tool_input?.file_path !== 'string') return;
  const lexical = path.resolve(event.cwd ?? process.cwd(),event.tool_input.file_path);
  const candidates = [lexical];
  try { candidates.push(await fs.realpath(lexical)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (event.tool_name !== 'Read' && candidates.some(file => normalized(file) === normalized(statePath))) {
    return deny(${JSON.stringify(DENY_PANEL_LOG)});
  }
  let value;
  try {
    const info = await fs.lstat(statePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ledger is not a regular file');
    value = JSON.parse(await fs.readFile(statePath,'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (value.version !== 1 || !Array.isArray(value.revokedPaths) || value.revokedPaths.some(file => typeof file !== 'string')) {
    throw new Error('Revocation ledger is invalid');
  }
  const revoked = value.revokedPaths.map(file => normalized(path.resolve(file)));
  if (candidates.some(file => revoked.some(root => {
    const rest = path.relative(root,normalized(file));
    return !rest || !path.isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + path.sep);
  }))) {
    deny(${JSON.stringify(DENY_DELETED)});
  }
}
main().catch(() => { deny(${JSON.stringify(DENY_UNVERIFIED)}); });
`}`
}
