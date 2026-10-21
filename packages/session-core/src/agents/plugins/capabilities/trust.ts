import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { PluginFs } from '../../runtime/fs';

export type TrustContext = {
  workspacePath: string;
  autoApprove?: boolean;
};

/**
 * 「这个工作区可信」怎么递给这一家 —— 四条通道,一家只声明一条,capability 与 behavior 两侧
 * 必须同一个答案。
 *
 * - `config-file`:写进这一家的配置文件。没有托管配置根的家写的是**用户那份**全局配置
 *   (cursor / copilot / pi 今天如此)—— 这是 product spec 明写要挡的
 *   落地写,之所以还在,是这几家还没人去查它们有没有运行时通道。❌ 新家别默认走这条。
 * - `runtime-env`:只在这一次 spawn 的 env 里说「可信」,进程退出两侧都不留字节。
 *   有运行时通道的家走这条(claude:`CLAUDE_CODE_SANDBOXED`)。
 * - `runtime-argv`:与 runtime-env 同一档,只是载体是 argv 上的旗标(mimocode:`--trust`)。
 *   同样不落一个字节;宿主把返回的参数追加到本次 spawn 的命令行尾部。
 * - `first-run-state`:托管配置根的家,信任由 `configRoot.firstRunState` 在影子 home 里落,
 *   这里没有第二个写者(kimi)。
 */
export type TrustChannel = 'config-file' | 'runtime-env' | 'runtime-argv' | 'first-run-state';

export type ConfigFileTrustBehavior = {
  channel: 'config-file';
  trustWorkspace(fs: PluginFs, ctx: TrustContext): Promise<void>;
};

export type RuntimeEnvTrustBehavior = {
  channel: 'runtime-env';
  /** 这一次 spawn 要多带的 env。❌ 不许在这里碰文件系统 —— 通道的定义就是不落地。 */
  trustEnv(ctx: TrustContext): Readonly<Record<string, string>>;
};

export type RuntimeArgvTrustBehavior = {
  channel: 'runtime-argv';
  /** 这一次 spawn 要在命令行尾部多带的参数。❌ 不许在这里碰文件系统 —— 通道的定义就是不落地。 */
  trustArgs(ctx: TrustContext): readonly string[];
};

export type FirstRunStateTrustBehavior = {
  channel: 'first-run-state';
};

export type ITrustBehavior =
  | ConfigFileTrustBehavior
  | RuntimeEnvTrustBehavior
  | RuntimeArgvTrustBehavior
  | FirstRunStateTrustBehavior;

/**
 * ⚠️ **没有默认值** —— owner 2026-09-03:「所有 agent harness 都得显式申明,这个是强类型,
 * 不存在灰色地带」。`definePluginCapability` 的 `_hasDefault` 是类型级开关:不给默认值,
 * 少写这一格的家在 **tsc** 就红,而不是被一个 `{ kind: 'none' }` 静默兜住。
 *
 * 兜住的代价是真的:2026-09-03 之前 36 家里只有 6 家写了这一格,其余 30 家的「没有信任通道」
 * 是默认值替它们说的 —— 没有任何人做过那个决定,也没人核过它们到底有没有通道。
 * 「如实标缺」必须是一句**说出口的话**(`{ kind: 'none' }`),不能是省略。
 */
export const trustCapability = definePluginCapability<ITrustBehavior>()(
  'trust',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('supported'),
      channel: z.enum(['config-file', 'runtime-env', 'runtime-argv', 'first-run-state']),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ])
);
