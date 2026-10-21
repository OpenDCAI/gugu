import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  ParseErrorCode,
  type ParseError,
} from 'jsonc-parser';
import * as toml from 'smol-toml';
import type { PluginFs } from '../../runtime/fs';
import { HarnessStartupError } from '../session-runtime-compatibility';
import type { HookRegistration, HookRuntimeFacts } from '../capabilities/hooks';
import { GUGU_HOOK_MARKER, LEGACY_HOOK_MARKER, filterUserHooks } from './hooks';

export type { HookCommandOptions } from './hooks';

// ── JSON config helpers ────────────────────────────────────────────────────

// @@@JSONC 而非严格 JSON —— 这些配置文件(qwen ~/.qwen/settings.json 等)厂商就当 JSONC 用,
// 用户在里面写 `//` 注释是受支持的正常用法(见 mcp.ts 对同一文件的处置)。
const JSON_FORMATTING = { insertSpaces: true, tabSize: 2 };

/**
 * JSON(C) 配置文件的**归属** —— 决定解析失败时是保全还是自愈。分流轴是「这文件是不是用户的」,
 * ❌ 不是按家 if/else:一个通用机制 + 一个参数(#4604 军师复核定案)。
 *  · 'user' —— 厂商的**主配置文件**(qwen/claude/qoder/auggie/commandcode 的 settings…),装着用户手写的
 *    model / api key / theme / 自己的 hooks;**以及归属存疑的文件**——见下。解析失败 = 读不动用户配置,
 *    **抛 `JsonConfigParseError`**;❌ 绝不覆盖——那正是 #4604 把整份配置抹成只剩咕咕 hooks 的数据丢失。
 *  · 'gugu-managed' —— 咕咕**专为注 hooks 而建**的文件,凭**出处**认定:路径带 gugu 归属标记
 *    (copilot/kiro/grok 的 `gugu.json`、以及 `…/gugu/…` 这类咕咕自建插件目录;改名前的标记是 `emdash`)⇒ 确证是咕咕造的、无用户内容。
 *    解析失败 = 咕咕自己的文件坏了 ⇒ **自愈**(当作空、下次写整份重建),等价旧码无条件覆盖的自愈行为。
 * ⚠️ **归属存疑时往安全侧倒 = 'user'**:代价不对称——误当用户文件顶多是坏了不自愈(卡一下),误当咕咕文件
 *    会**整份覆盖、删掉用户配置**(正是本票的 bug)。一句代码注释里的「这是咕咕自建」是**声明不是证据**;
 *    没有 gugu 出处标记就不升 'gugu-managed'(devin/droid 的 hooks 文件即因此归 'user')。
 */
export type JsonConfigOwnership = 'user' | 'gugu-managed';

/**
 * 解析失败时抛这个**可判别**的错,消息里带上出错文件的路径:它一路抛到会话启动失败上屏(#4604 findings ①)。
 * 坏的是这家 harness 的配置文件(用户自己的),不是咕咕:所以它是一句 `HarnessStartupError`,起任务失败时
 * 照原话上屏(#7103 谁拒绝谁说话),❌ 被折成「咕咕这边出错了」。
 * ⚠️ 用 `name` 判别而非 `instanceof`:跨包打包后 `instanceof` 会因类副本而失灵。
 */
export class JsonConfigParseError extends HarnessStartupError {
  constructor(
    readonly configPath: string,
    readonly detail: string
  ) {
    super(`Failed to parse ${configPath}: ${detail}`);
    this.name = 'JsonConfigParseError';
  }
}
export function isJsonConfigParseError(error: unknown): error is JsonConfigParseError {
  return error instanceof Error && error.name === 'JsonConfigParseError';
}

type JsonConfigOutcome =
  | { kind: 'empty' } // 无 JSON 值(空 / 纯空白 / 纯注释)—— 语义上等价于文件不存在
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'corrupt'; detail: string }; // 语法错,或合法 JSON 但根不是对象

// jsonc 解析 + 分类(形状由运行时实测:纯注释→parsed=undefined & errors=[ValueExpected];
// 截断带 error 7、垃圾带 error 1,故都不落 empty;null/[]/标量 errors 空但根非对象 → corrupt)。
function classifyJsonConfig(content: string): JsonConfigOutcome {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (parsed === undefined && errors.every((e) => e.error === ParseErrorCode.ValueExpected)) {
    return { kind: 'empty' };
  }
  if (errors.length > 0) {
    return { kind: 'corrupt', detail: `JSON(C) syntax error at offset ${errors[0].offset}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'corrupt', detail: 'root is not a JSON object' };
  }
  return { kind: 'object', value: parsed as Record<string, unknown> };
}

export async function readJsonConfig(
  fs: PluginFs,
  path: string,
  ownership: JsonConfigOwnership
): Promise<Record<string, unknown>> {
  const content = await fs.read(path);
  if (!content) return {}; // 文件真不存在 —— 用户没配置,这是 {} 的合法来源之一。
  const outcome = classifyJsonConfig(content);
  switch (outcome.kind) {
    case 'empty':
      return {}; // 无 JSON 值 = 等价于不存在(纯注释文件不承载配置)。
    case 'object':
      return outcome.value;
    case 'corrupt':
      // 用户文件:读不动 ≠ 没配置 —— 抛可判别错(❌ 不 catch→{},那是 #4604 的源头)。
      // 咕咕自有文件:自愈,当作空,交给下一次写整份重建。
      if (ownership === 'gugu-managed') return {};
      throw new JsonConfigParseError(path, outcome.detail);
  }
}

// 只改真正变化的顶层键(spot-edit),未变的键连注释带排版逐字保留;原文里有、新配置里没有的顶层键删掉。
// ⇒ writeJsonConfig 仍是「让文件等于这个对象」,但不再整篇重排、不再抹掉用户注释(#4604 / #4593)。
// ownership='gugu-managed' 且原文畸形 = **自愈**:丢弃坏字节、从 {} 种子整份重建(等价旧码无条件覆盖)。
export async function writeJsonConfig(
  fs: PluginFs,
  path: string,
  config: Record<string, unknown>,
  ownership: JsonConfigOwnership
): Promise<void> {
  const content = await fs.read(path);
  let original: Record<string, unknown> = {};
  let text = '{}\n';
  if (content && content.trim()) {
    const outcome = classifyJsonConfig(content);
    if (outcome.kind === 'object') {
      original = outcome.value;
      text = content; // 从原文出发 spot-edit,保注释、保排版。
    } else if (outcome.kind === 'empty') {
      // 非空白却没有键 = 纯注释:用户写了内容、只是还没有配置键。以原文为 seed 做定点编辑 —— 注释保住。
      // ❌ 别把它当"没有内容"从 {} 种子重建:那是「没有键 ≠ 没有内容」,与 #4604 的 catch→{} 同一个删除形状。
      text = content;
    } else if (outcome.kind === 'corrupt' && ownership === 'user') {
      throw new JsonConfigParseError(path, outcome.detail);
    }
    // corrupt + gugu-managed → 自愈(保持 {} 种子,整份重建)。
  }

  // 顶层键真变了才 modify;未变则跳过,那个键的原始文本(含其内部注释)整段不动。
  // isDeepStrictEqual(mcp.ts 已 import 的同一个)替掉手写深比 —— 顺带消掉「hooks 是 [] 时把 string 键写
  // 当成 vacuously equal 而静默跳过」那条恒真假等(手写数组分支只比索引,漏 string 键 ⇒ 装不上却报成功)。
  for (const [key, value] of Object.entries(config)) {
    if (!isDeepStrictEqual(original[key], value)) {
      text = applyEdits(text, modify(text, [key], value, { formattingOptions: JSON_FORMATTING }));
    }
  }
  for (const key of Object.keys(original)) {
    if (!(key in config)) {
      text = applyEdits(text, modify(text, [key], undefined, { formattingOptions: JSON_FORMATTING }));
    }
  }
  await fs.write(path, text);
}

/**
 * 卸载写回:剥掉我们自己的 hook 条目 —— **剥不出东西就不写这份文件**。
 *
 * 这里要判的不是"写什么内容",而是**该不该动它**。`config.hooks ?? {}` 那个兜底 `{}` 是**我们凭空造的**:
 * 原文没有 hooks 键时把它写回去,`writeJsonConfig` 的逐键 diff 看到 `undefined ≠ {}`,就往一份
 * **没有一个字节属于我们**的用户文件里注入 `"hooks": {}`(#4621 ①)—— 与 #4613 立的
 * 「ownership='user' 的文件我们无权动,只剥自己的条目」直接冲突。
 * 非数组的 hooks 值同理不是我们写的形状:原样留下,❌ 不 filter 它 —— `entries.filter` 会抛 TypeError,
 * 而 TypeError 不是 `JsonConfigParseError`,`bestEffortLegacy` 不咽,卸载会停在「主配置已剥、遗留未剥」
 * 的半完成态,比文件被改写更难恢复(#4621 ②)。
 *
 * 「文件不存在」不需要单独的守卫:`readJsonConfig` 对它返回 `{}` ⇒ 没有 hooks 键 ⇒ 本函数不写。
 *
 * ⚠️ 一处**有意的行为变化**:`ownership='gugu-managed'` 的畸形文件,旧码在卸载时会被整份重建成
 * `{"hooks":{}}`(读侧自愈 `{}` + 无条件写)。现在卸载对它**不写** —— 卸载没有理由去重建一份
 * 我们正要退出的文件,坏字节留在盘上更可诊断。自愈没有丢:下一次 `writeHooks` 照旧整份重建
 * (判据里带了这条的阳控)。
 */
export async function stripManagedJsonHooks(
  fs: PluginFs,
  configPath: string,
  ownership: JsonConfigOwnership
): Promise<void> {
  const config = await readJsonConfig(fs, configPath, ownership);
  const hooks = config.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return;

  const stripped: Record<string, unknown> = {};
  for (const [key, entries] of Object.entries(hooks)) {
    stripped[key] = Array.isArray(entries)
      ? filterUserHooks(entries as Record<string, unknown>[])
      : entries;
  }
  if (isDeepStrictEqual(hooks, stripped)) return;

  await writeJsonConfig(fs, configPath, { ...config, hooks: stripped }, ownership);
}

/**
 * 解析一份 JSON(C) 文本;根不是对象或有语法错时返回 `null`(空文本/纯注释算 `{}`)。
 * 与 `readJsonConfig` 同一个分类器,只是不经 PluginFs —— 给「只读判归属、再定点摘除」的调用方用。
 */
export function parseJsoncObject(text: string): Record<string, unknown> | null {
  const outcome = classifyJsonConfig(text);
  if (outcome.kind === 'empty') return {};
  return outcome.kind === 'object' ? outcome.value : null;
}

/** Merge a small TOML overlay into the existing document without re-stringifying it. */
export async function writeTomlOverlay(
  fs: PluginFs,
  path: string,
  entries: Record<string, unknown>
): Promise<void> {
  const raw = (await fs.read(path)) ?? '';
  const additions = tomlOverlayLines(entries);
  let output = raw;
  for (const addition of additions) {
    const sectionHeader = addition.section ? `[${addition.section}]` : '';
    const lines = output.split(/\r?\n/);
    const sectionStart = sectionHeader ? lines.findIndex((line) => line.trim() === sectionHeader) : -1;
    if (sectionHeader && sectionStart >= 0) {
      const nextSection = lines.slice(sectionStart + 1).findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
      const end = nextSection < 0 ? lines.length : sectionStart + 1 + nextSection;
      const keyIndex = lines.slice(sectionStart + 1, end).findIndex((line) => new RegExp(`^\\s*${escapeRegExp(addition.key)}\\s*=`).test(line));
      if (keyIndex >= 0) {
        const absolute = sectionStart + 1 + keyIndex;
        const comment = lines[absolute].match(/(\s+#.*)$/)?.[1] ?? '';
        lines[absolute] = `${addition.key} = ${addition.value}${comment}`;
      } else {
        lines.splice(end, 0, `${addition.key} = ${addition.value}`);
      }
      output = lines.join('\n');
      continue;
    }
    const prefix = output.length > 0 && !output.endsWith('\n') ? `${output}\n` : output;
    output = `${prefix}${sectionHeader ? `${sectionHeader}\n` : ''}${addition.key} = ${addition.value}\n`;
  }
  if (output !== raw) await fs.write(path, output);
}

type TomlOverlayLine = { section: string; key: string; value: string };

function tomlOverlayLines(value: Record<string, unknown>, parents: string[] = []): TomlOverlayLine[] {
  const lines: TomlOverlayLine[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child)) {
      lines.push(...tomlOverlayLines(child, [...parents, quoteTomlKey(key)]));
    } else {
      lines.push({ section: parents.join('.'), key: quoteTomlKey(key), value: tomlLiteral(child) });
    }
  }
  return lines;
}

function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`;
  throw new Error(`Unsupported TOML overlay value: ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Entry builders ─────────────────────────────────────────────────────────

/** 嵌套格式一组条目上除命令之外的两个选项(见 `HookSpec`)。 */
export type NestedHookEntryOptions = { matcher?: string; async?: true };

/** Claude/Codex-style nested entry. 写入与「装没装」都用它,键序固定。 */
export function buildNestedEntry(command: string, options: NestedHookEntryOptions = {}): Record<string, unknown> {
  const handler = { type: 'command', command, ...(options.async ? { async: true } : {}) };
  return { ...(options.matcher !== undefined ? { matcher: options.matcher } : {}), hooks: [handler] };
}

const nestedEntryOf = (spec: HookSpec) =>
  buildNestedEntry(spec.command, { matcher: spec.matcher, async: spec.async });

/** Copilot-style flat entry: `{ type: 'command', command }` */
export function buildFlatEntry(command: string): Record<string, unknown> {
  return { type: 'command', command };
}

/** Kiro-style minimal entry: `{ command }` */
export function buildMinimalEntry(command: string): Record<string, unknown> {
  return { command };
}

// ── Merge helpers ───────────────────────────────────────────────────────────

export function mergeFlatEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildFlatEntry(command)];
}

export function mergeMinimalEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildMinimalEntry(command)];
}

// ── TOML config helpers ────────────────────────────────────────────────────

export async function readTomlConfig(fs: PluginFs, path: string): Promise<Record<string, unknown>> {
  const content = await fs.read(path);
  if (!content) return {};
  try {
    return (toml.parse(content) as Record<string, unknown>) ?? {};
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${String(error)}`);
  }
}

export async function writeTomlConfig(
  fs: PluginFs,
  path: string,
  config: Record<string, unknown>
): Promise<void> {
  await fs.write(path, toml.stringify(config));
}

/**
 * 改名前咕咕专有文件的旧路径(`…/emdash.json`、`…/emdash/…`、`emdash-hook.ts` 这类)。写好新文件之后删掉 ——
 * 否则 agent 会同时加载新旧两份。只删**内容里带着旧钩子标记**的:同名文件如果是用户自己的,原样留下。
 */
export async function removeLegacyGuguFiles(fs: PluginFs, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const content = await fs.read(path).catch(() => null);
    if (content !== null && content.includes(LEGACY_HOOK_MARKER)) {
      await fs.delete(path).catch(() => {});
    }
  }
}

// ── Generic hook config builders ────────────────────────────────────────────

/**
 * 一条托管 hook。`sinceVersion` = 引入这个 hook 键的 harness 版本:比它旧的 harness 不认识这个键,
 * 而不少 harness 把配置里的**未知键当整份配置无效** —— 实测 Claude Code 2.1.77 见到 `StopFailure`
 * 就丢掉整份 hooks(SessionStart / Stop / Notification 全不响)。⇒ 版本不够的不写,并清掉以前写过的托管条目;
 * 版本探不到而又有 sinceVersion 的条目 ⇒ 响亮报错,❌ 默认按新版本装(spec hook-status-derivation)。
 *
 * 嵌套格式(Claude / qwen)另有两个选项:`matcher`(只对哪些工具触发)与 `async`(后台跑、不挡工具)。
 * 扁平 / 极简格式没有这两个字段,带了就拒绝,不悄悄丢掉过滤条件。
 */
export type HookSpec = { hookKey: string; command: string; sinceVersion?: string; matcher?: string; async?: true };

/** 扁平 / 极简格式的写入器只认命令本身;带嵌套专有选项的 spec 在这里就拒绝。 */
function assertNoNestedOnlyOptions(configPath: string, specs: readonly HookSpec[]): void {
  const offending = specs.filter((spec) => spec.matcher !== undefined || spec.async !== undefined);
  if (offending.length > 0) {
    throw new Error(
      `hooks in ${configPath} set matcher/async on ${offending.map((spec) => spec.hookKey).join(', ')}, `
        + 'which only the nested hook format carries',
    );
  }
}

export class HookRuntimeVersionRequiredError extends Error {
  constructor(configPath: string, hookKeys: string[]) {
    super(
      `hooks in ${configPath} declare sinceVersion for ${hookKeys.join(', ')}, `
        + 'but the harness version of this spawn is unknown; refusing to guess which keys it accepts',
    );
    this.name = 'HookRuntimeVersionRequiredError';
  }
}

/** 按这一次的 harness 版本把托管 hook 分成「写」与「这版不认、要清掉」两份。 */
function partitionHookSpecs(configPath: string, specs: HookSpec[], runtime: HookRuntimeFacts) {
  const gated = specs.filter((spec) => spec.sinceVersion !== undefined);
  if (gated.length > 0 && runtime.harnessVersion === null) {
    throw new HookRuntimeVersionRequiredError(configPath, [...new Set(gated.map((spec) => spec.hookKey))]);
  }
  const accepted = (spec: HookSpec) =>
    spec.sinceVersion === undefined || semver.gte(runtime.harnessVersion as string, spec.sinceVersion);
  const active = specs.filter(accepted);
  const activeKeys = new Set(active.map((spec) => spec.hookKey));
  const unsupportedKeys = [...new Set(specs.filter((spec) => !accepted(spec)).map((spec) => spec.hookKey))]
    .filter((key) => !activeKeys.has(key));
  return { active, unsupportedKeys };
}

/** 这版 harness 不认的键:只摘掉咕咕的托管条目,用户自己的留着;摘空了就连键一起删(空数组也是未知键)。 */
function dropUnsupportedKeys(hooks: Record<string, unknown[]>, keys: string[]): void {
  for (const key of keys) {
    const existing = Array.isArray(hooks[key]) ? hooks[key] : [];
    const user = filterUserHooks(existing as Record<string, unknown>[]);
    if (user.length > 0) hooks[key] = user;
    else delete hooks[key];
  }
}

/** 装没装上只看不分版本的那部分:有版本门的键在老版本上本来就不该在。 */
const baselineSpecs = (specs: HookSpec[]) => specs.filter((spec) => spec.sinceVersion === undefined);

/**
 * 嵌套格式的 `hooks` 对象本身(`{ <Event>: [{ hooks: [{ type: 'command', command }] }] }`)——
 * 会话级通道(run 目录里的配置文件 / 插件目录)直接拿它当内容,不经任何写入器、不读任何用户文件。
 */
export function nestedHooksObject(specs: readonly HookSpec[]): Record<string, Record<string, unknown>[]> {
  // 会话级通道拿不到这一次 spawn 的 harness 版本;带版本门的 spec 在这里没法判「写不写」⇒ 响亮拒绝,❌ 默认照写。
  const gated = specs.filter((spec) => spec.sinceVersion !== undefined);
  if (gated.length > 0) {
    throw new HookRuntimeVersionRequiredError('session hooks channel', [...new Set(gated.map((spec) => spec.hookKey))]);
  }
  const hooks: Record<string, Record<string, unknown>[]> = {};
  for (const spec of specs) {
    hooks[spec.hookKey] = [...(hooks[spec.hookKey] ?? []), nestedEntryOf(spec)];
  }
  return hooks;
}
type FlatTomlHookConfigOptions = {
  beforeWrite?: (fs: PluginFs) => Promise<void>;
  afterWrite?: (fs: PluginFs) => Promise<string[]>;
  afterDelete?: (fs: PluginFs) => Promise<void>;
  stringifyEntry?: (entry: Record<string, unknown>) => string;
};

/**
 * Build an `IHooksBehavior` for agents that store hooks as a flat TOML array:
 *   `[[hooks]]` / `{ hooks = [{ ... }] }`
 */
export function buildFlatTomlHookConfig(
  configPath: string,
  entries: Record<string, unknown>[],
  options: FlatTomlHookConfigOptions = {}
) {
  const stringifyEntry = options.stringifyEntry ?? JSON.stringify;
  const getHookEntries = (config: Record<string, unknown>) =>
    Array.isArray(config.hooks) ? (config.hooks as Record<string, unknown>[]) : [];
  const hasGuguHook = (config: Record<string, unknown>) =>
    getHookEntries(config).some((entry) => stringifyEntry(entry).includes(GUGU_HOOK_MARKER));

  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readTomlConfig(fs, configPath);
      return hasGuguHook(config) ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readTomlConfig(fs, configPath);
      await options.beforeWrite?.(fs);
      const userHooks = filterUserHooks(getHookEntries(config), stringifyEntry);
      await writeTomlConfig(fs, configPath, { ...config, hooks: [...userHooks, ...entries] });
      const extraPaths = (await options.afterWrite?.(fs)) ?? [];
      return [configPath, ...extraPaths];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readTomlConfig(fs, configPath);
      await writeTomlConfig(fs, configPath, {
        ...config,
        hooks: filterUserHooks(getHookEntries(config), stringifyEntry),
      });
      await options.afterDelete?.(fs);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readTomlConfig(fs, configPath);
      return hasGuguHook(config);
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks in a JSON file using
 * the nested format:
 *   `{ hooks: { <Event>: [{ hooks: [{ type: 'command', command }] }] } }`
 *
 * Pass pre-built command strings (from `makeStdinHookCommand`, etc.) in `hookSpecs`.
 */
export function buildNestedJsonHookConfig(
  configPath: string,
  hookSpecs: HookSpec[],
  ownership: JsonConfigOwnership
) {
  const groupByKey = (specs: HookSpec[]) => {
    const byKey = new Map<string, HookSpec[]>();
    for (const spec of specs) byKey.set(spec.hookKey, [...(byKey.get(spec.hookKey) ?? []), spec]);
    return byKey;
  };
  const baselineByKey = groupByKey(baselineSpecs(hookSpecs));

  // 「装上了」= 每条托管 spec 都以此刻的完整形状(含 matcher / async)在文件里;旧形状的下次写入会换掉。
  const hasAllManagedNestedEntries = (hooks: Record<string, unknown[]>): boolean =>
    [...baselineByKey].every(([hookKey, specs]) => {
      const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
      const serializedEntries = entries.map((entry) => JSON.stringify(entry));
      return specs.every((spec) => serializedEntries.includes(JSON.stringify(nestedEntryOf(spec))));
    });

  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return hasAllManagedNestedEntries(hooks) ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[], runtime: HookRuntimeFacts): Promise<string[]> {
      const { active, unsupportedKeys } = partitionHookSpecs(configPath, hookSpecs, runtime);
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      dropUnsupportedKeys(hooks, unsupportedKeys);
      for (const [hookKey, specs] of groupByKey(active)) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = [
          ...filterUserHooks(existing as Record<string, unknown>[]),
          ...specs.map(nestedEntryOf),
        ];
      }
      await writeJsonConfig(fs, configPath, { ...config, hooks }, ownership);
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      await stripManagedJsonHooks(fs, configPath, ownership);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return hasAllManagedNestedEntries(hooks);
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks in a JSON file using
 * the flat format: `{ hooks: { <Event>: [{ type: 'command', command }] } }`
 *
 * Optionally pass `extraFields` to merge at the config root (e.g. copilot `version`).
 */
export function buildFlatJsonHookConfig(
  configPath: string,
  hookSpecs: HookSpec[],
  ownership: JsonConfigOwnership,
  extraRoot?: Record<string, unknown>
) {
  assertNoNestedOnlyOptions(configPath, hookSpecs);
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = baselineSpecs(hookSpecs).some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER));
      });
      return installed ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[], runtime: HookRuntimeFacts): Promise<string[]> {
      const { active, unsupportedKeys } = partitionHookSpecs(configPath, hookSpecs, runtime);
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      dropUnsupportedKeys(hooks, unsupportedKeys);
      for (const { hookKey, command } of active) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = mergeFlatEntries(existing, command);
      }
      await writeJsonConfig(fs, configPath, { ...config, ...extraRoot, hooks }, ownership);
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      await stripManagedJsonHooks(fs, configPath, ownership);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return baselineSpecs(hookSpecs).some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER));
      });
    },
  };
}

/**
 * Build an `IHooksBehavior` for agents that store hooks as a minimal
 * `{ command }` object array under `config.hooks.<hookKey>`.
 */
export function buildMinimalJsonHookConfig(
  configPath: string,
  hookSpecs: HookSpec[],
  ownership: JsonConfigOwnership,
  extraRoot?: Record<string, unknown>,
  /** 这个文件改名前的路径,见 `removeLegacyGuguFiles`。 */
  legacyConfigPaths: readonly string[] = []
) {
  assertNoNestedOnlyOptions(configPath, hookSpecs);
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = baselineSpecs(hookSpecs).some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER));
      });
      return installed ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[], runtime: HookRuntimeFacts): Promise<string[]> {
      const { active, unsupportedKeys } = partitionHookSpecs(configPath, hookSpecs, runtime);
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      dropUnsupportedKeys(hooks, unsupportedKeys);
      for (const { hookKey, command } of active) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = mergeMinimalEntries(existing, command);
      }
      await writeJsonConfig(fs, configPath, { ...config, ...extraRoot, hooks }, ownership);
      await removeLegacyGuguFiles(fs, legacyConfigPaths);
      return [configPath];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      await stripManagedJsonHooks(fs, configPath, ownership);
      await removeLegacyGuguFiles(fs, legacyConfigPaths);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, configPath, ownership);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return baselineSpecs(hookSpecs).some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER));
      });
    },
  };
}
