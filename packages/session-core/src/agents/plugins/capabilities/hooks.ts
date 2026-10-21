import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { PluginFs } from '../../runtime/fs';
import { HOOK_EVENTS, type CanonicalHookEvent, type HookRegistration } from './hooks-types';
import { citedEvidenceSchema, type HarnessSessionChannelKind } from './session-bundle';

export type { HookRegistration };
export type { CanonicalHookEvent, HookEvent, HookWaitKind, NotificationType } from './hooks-types';
export { HOOK_EVENTS, HOOK_WAIT_KINDS } from './hooks-types';

/**
 * 这一次将要 spawn 的那份 harness 的事实。`harnessVersion` 取自 runtime-compatible 探针对**同一个可执行文件**
 * 的读数;没有声明 runtimeCompatibility 的家拿不到版本,是 `null`。
 */
export type HookRuntimeFacts = { harnessVersion: string | null };

/**
 * `readHooks` / `writeHooks` / `deleteHooks` / `getHooksInstalled` 是**写入器**:只给 hook 条目落在
 * 文件里的家(`scope: 'workspace' | 'agent-home'`)。`scope: 'session'` 的家由会话物化器交付,
 * ❌ 不许再挂一个写入器 —— 一个没人调的写入器就是一条随时会被接回去、往用户 HOME 写的路
 * (考卷:`conformance/session-hooks-conformance.test.ts`)。
 */
export type IHooksBehavior = {
  readHooks?(fs: PluginFs): Promise<HookRegistration[]>;
  /** Write hooks and return the root-relative paths written. */
  writeHooks?(fs: PluginFs, hooks: HookRegistration[], runtime: HookRuntimeFacts): Promise<string[]>;
  deleteHooks?(fs: PluginFs): Promise<void>;
  getHooksInstalled?(fs: PluginFs): Promise<boolean>;
  /**
   * Parse a raw hook event (event type header + JSON body) into a canonical form.
   * Optional — the desktop falls back to defaultHookEventParser when absent.
   */
  parseHookEvent?(eventType: string, body: Record<string, unknown>): CanonicalHookEvent;
  /** 这一家 harness 自己写的「会话在场」文件(descriptor 的 `hooks.presence` 声明了才有),见 `HarnessPresenceFile`。 */
  presence?: HarnessPresenceFile;
};

/**
 * spec hook-status-derivation「打断边:会话在场文件」—— harness 自己为每个交互进程写的一份在场记录
 * (Claude Code:`<配置目录>/sessions/<pid>.json`)。咕咕只从它读「停下了」这一件事:hooks 不报打断(Esc)。
 */
export type HarnessPresenceStatus = 'busy' | 'idle' | 'waiting' | 'shell';
export type HarnessPresence = { pid: number; sessionId: string; status: HarnessPresenceStatus };
export type HarnessPresenceFile = {
  /** 配置目录:这个环境变量(取这次 spawn 的 env)给了就用它,否则 `<HOME>/<defaultConfigDirName>`。 */
  configDirEnvVar: string;
  defaultConfigDirName: string;
  /** 配置目录下放在场文件的子目录;文件名 = `<pid>.json`。 */
  directory: string;
  /** 一份在场文件的内容 → 读数。缺字段、出现不认识的取值 ⇒ 抛(协议变了,❌ 猜)。 */
  parse(text: string): HarnessPresence;
};

/** 与 `HOOK_EVENTS` 同一份词表(`supportedEvents` = 这一家的 hook 产物真报得出的规范边,#5922)。 */
const hookEvents = z.array(z.enum(HOOK_EVENTS));

/**
 * 咕咕的 hook 条目经哪条**会话级**通道到达这一家。沿用 `HarnessSessionChannelKind`
 * (与 `selfUpdate` 同一套词,#6186 / #6195):
 *
 * - `session-env`  —— 条目写进 run 目录里的一份配置文件,由厂商自己的路径环境变量指过去
 *   (qwen:`QWEN_CODE_SYSTEM_SETTINGS_PATH`)。
 * - `session-argv` —— 条目随这一次启动的会话级配置覆盖一起递(codex:`-c notify=…`,
 *   app-server 腿是同一个值进 thread-open 的 config map)。
 *
 * 查不到会话级通道(`upstream-blocked`)的家不在这里声明:hooks 直接写 `kind: 'none'`,
 * ❌ 不许为了装 hook 去写用户 HOME 下的任何配置。
 */
const HOOK_SESSION_CHANNELS = ['session-env', 'session-argv'] as const satisfies readonly HarnessSessionChannelKind[];
export type HookSessionChannel = (typeof HOOK_SESSION_CHANNELS)[number];

/**
 * hooksDescriptor is used to describe the hooks that an agent supports.
 *
 * kind: 'config'  — hooks written into agent config file(s); `scope` says **whose** file:
 *   · 'workspace'  —— 任务工作区里的项目配置(写入器落盘,路径进 .gitignore);
 *   · 'agent-home' —— 咕咕托管的独立配置根(`sessionBundle.configRoot`);解析出来是用户真 HOME
 *                     就响亮失败,❌ 不写;
 *   · 'session'    —— 会话自有:由这一家终端腿的会话物化器按 `channel` 交付,写入器**一个字节都不写**。
 * kind: 'plugin'  — hooks delivered via a dropped file/plugin
 * kind: 'none'    — agent does not support lifecycle hooks
 */
const hooksDescriptorSchema = z.union([
  z.object({
    kind: z.literal('config'),
    scope: z.enum(['workspace', 'agent-home']),
    supportedEvents: hookEvents,
    /**
     * 从这个版本起这一家写会话在场文件,咕咕从它读 hooks 不报的打断边(行为:`IHooksBehavior.presence`)。
     * 声明了而这一次拿不到版本 ⇒ 响亮报错。
     */
    presence: z.object({ sinceVersion: z.string() }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('config'),
    scope: z.literal('session'),
    channel: z.enum(HOOK_SESSION_CHANNELS),
    evidence: citedEvidenceSchema('hooks session channel'),
    supportedEvents: hookEvents,
  }).strict(),
  z.object({
    kind: z.literal('plugin'),
    scope: z.enum(['global', 'workspace']),
    supportedEvents: hookEvents,
  }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export type HooksDescriptor = z.infer<typeof hooksDescriptorSchema>;

export const hooksCapability = definePluginCapability<IHooksBehavior>()('hooks', hooksDescriptorSchema, { kind: 'none' });
