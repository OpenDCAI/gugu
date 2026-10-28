// 生成脚本里的文案放在 String.raw 之外、按 JSON 插进去:raw 段里的非 ASCII 会让整份主进程 bundle 按双字节常驻(#655)。
const SENSITIVE_NOTE_VALUE = /(?:验证码|校验码|动态码|verification\s+code|one[- ]time\s+(?:code|password)|\bOTP\b)[^\r\n\d]{0,16}[0-9]{4,8}\b|(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret[_ -]?key|bearer|令牌|密钥)\s*(?:is|是|为|[:：=])?\s*[\x60'" ]*[A-Za-z0-9._~+/=-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9_-]{16,}/i;
const DENY_PENDING_WORK = '没办完的事由宿主维护；不能手写或覆盖。只在 working-context.md 补充主人后加的限制及来源。';
const DENY_OUTSIDE_MEMORY = '记忆文件路径没有落在助理记忆目录，不能经链接写入其他位置。';
const DENY_EDIT_UNREAD = '请先读取便笺并核对本次编辑位置。';
const DENY_SENSITIVE = '记忆和便笺不保存验证码、令牌或密钥。去掉具体值，只保留原始来源、未完成事项与必要约束，再保存。';
const DENY_CHECK_FAILED = '记忆写入检查失败；本次没有写入，请核对目录和文件后重试。';

/** Native write boundary: reject sensitive note values before Write/Edit can persist them. */
export function assistantNoteWriteHook(memoryDir: string): string {
  return `const memoryDir = ${JSON.stringify(memoryDir)};
${String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const sensitive = ${SENSITIVE_NOTE_VALUE};
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const real = async file => { try { return await fs.realpath(file); } catch (e) { if (e.code === 'ENOENT') return path.resolve(file); throw e; } };
const deny = reason => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
async function main() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (event.hook_event_name !== 'PreToolUse' || !['Write', 'Edit'].includes(event.tool_name)) return;
  const args = event.tool_input ?? {};
  if (typeof args.file_path !== 'string') return;
  const root = await real(memoryDir);
  const lexical = path.resolve(event.cwd ?? process.cwd(), args.file_path);
  const parent = await real(path.dirname(lexical));
  let actual;
  try { actual = await fs.realpath(lexical); } catch (error) { if (error.code !== 'ENOENT') throw error; actual = path.join(parent, path.basename(lexical)); }
  if (![lexical, actual, path.join(parent, path.basename(lexical))].some(file => within(root, file) || within(path.resolve(memoryDir), file))) return;
  if (path.basename(lexical) === 'pending-work.json') return deny(${JSON.stringify(DENY_PENDING_WORK)});
  if (!within(root, actual) || !within(root, parent)) return deny(${JSON.stringify(DENY_OUTSIDE_MEMORY)});
  let next;
  if (event.tool_name === 'Write') next = args.content;
  else {
    const previous = await fs.readFile(actual, 'utf8');
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || !args.old_string || !previous.includes(args.old_string)) return deny(${JSON.stringify(DENY_EDIT_UNREAD)});
    if (args.replace_all) next = previous.split(args.old_string).join(args.new_string);
    else { const start = previous.indexOf(args.old_string); next = previous.slice(0, start) + args.new_string + previous.slice(start + args.old_string.length); }
  }
  if (typeof next === 'string' && sensitive.test(next)) deny(${JSON.stringify(DENY_SENSITIVE)});
}
main().catch(() => { deny(${JSON.stringify(DENY_CHECK_FAILED)}); process.exitCode = 0; });
`}`
}
