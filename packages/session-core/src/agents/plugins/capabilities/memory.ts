import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { PluginFs } from '../../runtime/fs';

/**
 * agent memory —— 磁盘上 agent **自己会去读**的文件(`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` /
 * `.cursor/rules/*.mdc` 这一族)。
 *
 * ❌ 与 `sessionBundle.units.promptBlocks` 是两件事,不许混:
 *  · `promptBlocks` = 咕咕**每次会话注入**的提示块,随会话生灭,咕咕是作者;
 *  · 本条         = **用户/agent 自己写在磁盘上**的文件,跨会话持久,咕咕是读者。
 * 混进同一个字段,会让「咕咕塞进去的东西」冒充「引擎本来就有的记忆」。
 *
 * 与 `sessionBundle.coexistence.memory` 的分工:
 *  · 这里(`capabilities.memory`)记**厂商事实** —— 这一家的引擎去读哪个文件。判据同
 *    `hostDependency.binaryNames`:出处是厂商官方文档,写错了引擎就读不到。
 *  · 那里(`coexistence.memory`)记**咕咕事实** —— 咕咕接没接通这一维。只有当这里
 *    声明了文件、且宿主经 `AgentPluginHost.readMemoryFiles` 真读得到时,那边才够格写 `native`。
 */

/**
 * 作用域。**必须分开建模**,不是分类癖:
 *  · `global`  锚在用户 home(`~/.claude/CLAUDE.md`),一个用户一份;
 *  · `project` 锚在工作区根(`./AGENTS.md`),一个仓一份,**通常在 git 里、和同事共享**。
 *
 * 技术上也躲不开:`AgentPluginHost.fs` 三处构造点全是 `createLocalPluginFs(homeDir)`
 * (session-runtime/src/agent-config/node/index.ts:33 等),而 `local-plugin-fs.ts:14` 的
 * `resolveSafe` 对任何越出 root 的路径**抛异常**。所以 project 作用域拿宿主那把 fs
 * 根本够不着,必须由调用方另给一把锚在工作区的 fs —— 见 `readMemoryFiles` 的入参形状。
 */
/**
 * 产品里「记忆源」的 id 与 registry 里 provider 的 id **不是一套词表**,这里做映射。
 *
 * `AgentMemorySource`(`core/shared/types/agentProvision.ts`)是走云端载荷、并且**落库**的那套
 * (`memory_sources TEXT[]`),历史值是 `'claude-code'`;而 registry 里那一家的 id 是 `'claude'`。
 * 两边同名的只有 codex。
 *
 * ⚠️ 这不是洁癖,是一个真踩到的坑:把记忆读口从写死的两行路径改成按 registry 查之后,
 * `pluginRegistry.get('claude-code')` 返回 `undefined` —— **claude 的记忆会静默不再被读**,
 * 而且 tsc 绿、测试绿,用户只会发现「我的 CLAUDE.md 突然不被继承了」。
 * 落库的旧值改不得,所以别名表是必需的,不是过渡。
 */
const MEMORY_SOURCE_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
};

/**
 * 把一个记忆源 id 解析成 registry 的 provider id。
 *
 * 没有别名的原样返回 —— 于是产品将来把选择器放开到全部 36 家时,这里不用跟着改。
 */
export function memorySourceToProviderId(source: string): string {
  return MEMORY_SOURCE_PROVIDER_ALIASES[source] ?? source;
}

/** 已知会经云端载荷落库的记忆源 id。守卫用它反查别名表有没有烂掉。 */
export const PERSISTED_MEMORY_SOURCE_IDS: readonly string[] = ['claude-code', 'codex'];

export type AgentMemoryScope = 'global' | 'project';

/**
 * 合法通道,与 `SessionCoexistence.memory` 的 `UnitDelivery` channel 同集:
 *  · `agents-md`   跨厂商的 `AGENTS.md` 约定(agents.md 那一族);
 *  · `vendor-file` 这一家自己的专名文件(`CLAUDE.md` / `GEMINI.md` / `.cursor/rules` ...)。
 */
export type AgentMemoryChannel = 'agents-md' | 'vendor-file';

/**
 * 一条记忆入口。两种形态都是实测存在的,不是预留:
 *  · `file`      单文件(绝大多数家);
 *  · `directory` 一整目录规则文件(cursor 的 `.cursor/rules/*.mdc`)。
 *    只收**顶层**条目,且必须按后缀过滤 —— 目录里混着 README/备份是常态,全收会把
 *    不是记忆的东西当记忆读回来。
 */
export type AgentMemoryEntry =
  | { kind: 'file'; scope: AgentMemoryScope; channel: AgentMemoryChannel; path: string }
  | {
      kind: 'directory';
      scope: AgentMemoryScope;
      channel: AgentMemoryChannel;
      path: string;
      suffixes: readonly string[];
    };

/**
 * ⚠️ 只有读,**没有写**。这是决定,不是没做完:
 *  1. 这些文件是用户自己的手写内容,project 作用域下多半还在 git 里 —— 写错等于改坏受版本
 *     控制的文件,咕咕没有撤销;
 *  2. 咕咕**认不出哪一段是自己的**。MCP/hooks 能写是因为那是结构化配置里一个具名键
 *     (`buildNestedJsonHookConfig` 靠 GUGU_HOOK_MARKER 认领),markdown 没有这种把手。要写就得
 *     先发明一套标记约定 —— 那是产品决定,不是架构决定;
 *  3. 咕咕要让引擎知道什么,已有正规通道:`sessionBundle.units.promptBlocks`。写进人家的记忆
 *     文件意味着咕咕退场后残留还在,正是 `violates-zero-residue` 挡的事。
 *
 * 故本 capability 不带 behavior:36 家的差异全在「哪个文件」这一层数据上,读法是同一个。
 * 加一家 = 加一段声明,不是加一份实现。要加写口,应另开一个 kind 并先定标记约定,
 * ❌ 别在这里加个 `writable: true`。
 */
export type AgentMemoryDescriptor =
  | { kind: 'files'; entries: readonly AgentMemoryEntry[] }
  | { kind: 'none' };

/** 一条读回来的记忆。`content` 为 null = 声明了但磁盘上没有(用户没写过)。 */
export interface AgentMemoryDocument {
  scope: AgentMemoryScope;
  channel: AgentMemoryChannel;
  /** 相对该作用域根的路径。目录入口展开后,这里是目录内那个具体文件。 */
  path: string;
  content: string | null;
}

const entrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    scope: z.enum(['global', 'project']),
    channel: z.enum(['agents-md', 'vendor-file']),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('directory'),
    scope: z.enum(['global', 'project']),
    channel: z.enum(['agents-md', 'vendor-file']),
    path: z.string().min(1),
    suffixes: z.array(z.string().min(1)).min(1),
  }),
]);

/**
 * ⚠️ 显式钉成 `z.ZodType<AgentMemoryDescriptor>`,理由同 `session-bundle.ts` 里那条:
 * `plugins/framework.ts` 存的是 `parsed.data` 而不是作者写的原字面量,schema 里少一个键,
 * 那个字段就在运行时**静默消失** —— tsc 不红、测试不红,源码里明明写着,读出来却是 undefined。
 * 钉住类型后,schema 漏键会在这一行当场编译失败。
 *
 * ⚠️ 代价:zod 4 的 `ZodType<Output>` 把 Input 留成 `unknown`,于是 `definePlugin` 里这一格的
 * 作者输入**不受类型检查**。各家声明必须自带 `satisfies AgentMemoryDescriptor`
 * (同 `satisfies SessionBundleDescriptor` 的理由),否则写错通道名、漏掉 suffixes 都要等到
 * 运行时才发现。
 */
const memoryDescriptorSchema: z.ZodType<AgentMemoryDescriptor> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('files'), entries: z.array(entrySchema).min(1) }),
  z.object({ kind: z.literal('none') }),
]);

export const memoryCapability = definePluginCapability()(
  'memory',
  memoryDescriptorSchema,
  { kind: 'none' }
);

/** 这一家在该作用域下声明的入口。未声明 memory 的家返回空数组。 */
export function memoryEntriesForScope(
  descriptor: AgentMemoryDescriptor,
  scope: AgentMemoryScope
): readonly AgentMemoryEntry[] {
  if (descriptor.kind !== 'files') return [];
  return descriptor.entries.filter((entry) => entry.scope === scope);
}

/** 这一家在该作用域下接通了哪些通道 —— `coexistence.memory` 的 channel 只能取自这里。 */
export function memoryChannelsForScope(
  descriptor: AgentMemoryDescriptor,
  scope: AgentMemoryScope
): readonly AgentMemoryChannel[] {
  return [...new Set(memoryEntriesForScope(descriptor, scope).map((entry) => entry.channel))];
}

/**
 * 按声明把该作用域下的记忆文件读回来。
 *
 * `fs` **必须锚在该作用域的根**:`global` 用 home、`project` 用工作区根。传错了不会报错,
 * 只会静默读到空 —— 所以宿主侧的 `readMemoryFiles` 把这件事做成了类型上躲不开的入参。
 */
export async function readAgentMemoryDocuments(
  descriptor: AgentMemoryDescriptor,
  scope: AgentMemoryScope,
  fs: PluginFs
): Promise<AgentMemoryDocument[]> {
  const documents: AgentMemoryDocument[] = [];
  for (const entry of memoryEntriesForScope(descriptor, scope)) {
    if (entry.kind === 'file') {
      documents.push({
        scope: entry.scope,
        channel: entry.channel,
        path: entry.path,
        content: await fs.read(entry.path),
      });
      continue;
    }
    // 目录入口:只收顶层、只收声明后缀。list() 在目录不存在时返回 [](local-plugin-fs.ts:52),
    // 于是「没这个目录」和「目录是空的」都表现为零条 —— 对读者来说是同一件事。
    const names = (await fs.list(entry.path)).filter((name) =>
      entry.suffixes.some((suffix) => name.endsWith(suffix))
    );
    for (const name of names.sort()) {
      const path = `${entry.path.replace(/\/+$/, '')}/${name}`;
      documents.push({
        scope: entry.scope,
        channel: entry.channel,
        path,
        content: await fs.read(path),
      });
    }
  }
  return documents;
}
