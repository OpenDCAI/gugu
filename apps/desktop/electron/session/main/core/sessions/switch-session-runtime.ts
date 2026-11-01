import { sessionLife } from './session-life';
import { and, eq } from 'drizzle-orm';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { assertSessionSurfaceDeclared } from '@main/core/agents/session-runtime-compatibility';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import {
  sessionViewOfRuntime,
  sessionpageLegOfView,
  type SessionRuntime,
} from '@shared/core/sessions/sessions';
import { dehydrateSession } from './dehydrateSession';

/**
 * 把**已经存在的这条会话**换成另一种展示重开(spec session-runtime-switch):
 * 编程模式(pty,harness 自己的 TUI)⇄ 通用模式(acp,咕咕渲染的聊天面)。
 *
 * ## 它做两件事,一件都不多
 *
 * 1. **停掉当前这条腿** —— ACP 停适配器连接,pty 摘掉伪终端。活着的进程换不了形态,
 *    也不能两条腿同时挂在一条会话上(同一个 provider 会话被两个进程写,历史就废了)。
 * 2. **把 `runtime` 与 `config.type` 改成目标那一种**,然后发 `session:changed`。
 *
 * ❌ 它**不负责把新那条腿起起来**。起哪条腿由那条腿平常打开会话的那条路负责
 * (pty 走 `hydrateSession` 的补水协调器,ACP 由 acp-chat 页签 bootstrap)——
 * 渲染端换了页签种类,那条路就自己跑起来了。在这里再写一份 start,等于把「打开一条会话」
 * 实现两遍:两份之间任何一处不一致,都会变成「从菜单切过去的会话」和「平常打开的会话」
 * 脾气不同,而这种差别在界面上看不出来。
 *
 * ## 历史怎么续
 *
 * 靠**同一个 provider 会话 id**(`sessions.provider_session_id` 一个字节都不动):
 * pty 那条腿用它 `--resume`,ACP 那条腿用它 `session/load`。所以这不是「新开一条」——
 * 会话 id、标题、在任务里的位置全都原样保留。
 *
 * ⚠️ 续得上**是那一家 harness 的事实,不是这里的承诺**:一家把两条腿的会话 id 记在不同地方,
 * 换过去就只能从头开始。那时用户会在新那条腿上看到它自己的「起不来 / 会话不见了」状态
 * (`provider-session-recovery`),❌ 这里不预判、也不替它道歉 —— 事前把一个只在某些家成立的
 * 损失说成确定,会让用户躲开一个其实安全的动作(与 `session-reload-confirm` 里撤掉的那句同因)。
 *
 * ## ❌ 不接受的两件事
 *
 * - 目标 = 当前:直接抛。菜单不该摆这一项,摆了就是假控件;真走到这里说明有别的东西错了。
 * - 这一家没有目标那条腿:抛 `assertSessionSurfaceDeclared` 的原话。它是 spawn 时同一道闸 ——
 *   与其让用户切过去再撞一次「does not declare a session-TUI host adapter」,不如在这里就说清。
 */
export async function switchSessionRuntime(
  projectId: string,
  sessionId: string,
  runtime: SessionRuntime
): Promise<void> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.projectId, projectId),
      )
    )
    .limit(1);
  if (!row) throw new Error('Session not found');
  if (!row.config) throw new Error(`Session has no config: ${sessionId}`);

  // 缺席按 pty 读 —— 与 `mapSessionRowToSession` 同一把尺子。
  const current: SessionRuntime = row.runtime === 'acp' ? 'acp' : 'pty';
  if (current === runtime) {
    throw new Error(
      `[session-runtime-switch] 这条会话已经是 ${runtime} 了:${sessionId}。` +
        `切换只在两种展示之间发生;要原地重开走「重启本任务」。`
    );
  }

  // spawn 时同一道闸,提前到这里:这一家有没有目标那条腿。
  // 连 harness 都没记下的会话直接抛 —— 那种记录连「起哪条腿」都答不上来,❌ 不猜一个默认家。
  const providerId = row.provider;
  if (!providerId) {
    throw new Error(`[session-runtime-switch] 这条会话没有记下 harness:${sessionId}`);
  }
  assertSessionSurfaceDeclared({
    providerId,
    surface: sessionpageLegOfView(sessionViewOfRuntime(runtime)),
    descriptor: getPlugin(providerId).capabilities.sessionBundle,
  });

  // 先停,再改记录。反过来的话,停的那一刻记录已经说自己是另一条腿了 —— dehydrate 会当场
  // 提前返回(它对 acp 会话不做事),伪终端就留在那里活着,而界面已经切走。
  if (current === 'acp') {
    // session-life stops it without a barrier; with the record switched it is no longer a Life session.
    await sessionLife().interrupt(sessionId, { k: 'interrupt', reason: 'reconfigure' });
    if (sessionLife().read(sessionId).kind === 'failed') throw new Error(`ACP session ${sessionId} could not be stopped for the runtime switch`);
  } else {
    await dehydrateSession(projectId, sessionId);
  }

  const nextConfig = configForRuntime(row.config, runtime, {
    // 从通用模式搬走时,`session_id` 里那个 id 是 **ACP 适配器铸的**(与 conversation.id 不同)。
    // 编程腿续跑要用它,而不是咕咕自己的 conversation.id —— 后者在引擎侧根本不存在,续出来的是
    // 一条全新的空会话,且**不会报错**(2026-09-09 本机实测 claude:transcript 落在
    // `~/.claude/projects/<cwd>/<适配器铸的 id>.jsonl`,用 conversation.id 那条文件不存在)。
    providerMintedSessionId:
      current === 'acp' && !!row.providerSessionId && row.providerSessionId !== sessionId,
  });
  await db
    .update(sessions)
    .set({ runtime, config: nextConfig, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, sessionId));

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    changes: { runtime },
  });

  log.info('switchSessionRuntime: session moved to the other view', {
    sessionId,
    from: current,
    to: runtime,
    // 有没有 provider 会话 id 决定了新那条腿是续上还是从头 —— 事后排查最先要问的就是这个。
    providerSessionId: row.providerSessionId === null ? null : 'present',
  });
}

/**
 * 换腿之后这份 config 该长什么样。
 *
 * 共有的字段(模型、权限档、推理档、名字、谱系、首轮记录…)原样带走 —— 它们说的是**这条会话**,
 * 与它跑在哪条腿上无关。只丢**属于那条已经死掉的腿**的三类:
 *
 * - `initialPrompt` / `initialQueue`:首轮的投递载荷。会话早就跑起来了,带过去只会让新那条腿
 *   把第一句话**再投一次**(两边的首启判据都是 `session_id === null`,这里恒不为 null,
 *   所以今天投不出去 —— 但留着它就是给下一个人埋一颗「为什么它又说了一遍开场白」)。
 * - `providerSessionEndpoint`:宿主给**那个 TUI 进程**记的控制端点。进程都没了,端点是条死链。
 * - `mcpSessionServers`:那条 ACP 适配器**起进程那一刻**带上的几台(事实)。新进程还没起,
 *   这一格现在无人认领;缺席正是它定义好的「老会话」态 —— 面板退回只用意图算,下次重开自愈。
 *
 * 反过来**要记上**一条来历:从通用模式搬走时,`session_id` 里那个 id 是引擎铸的,
 * 编程腿续跑得用它 ⇒ 落 `providerMintedSessionId`(见 `resolveAgentSessionCommandArgs`)。
 *
 * ⚠️ `mcpDisabledServers` / `mcpToggleDecided`(**意图**:用户在 `/mcp` 里关掉了哪几台)只长在
 * ACP 那份 schema 上 —— 换到编程模式时它们随 schema 一起被剥掉,再切回来是一份干净的默认。
 * 那是今天的事实,不是一个决定:`/mcp` 面板本身就只在通用模式里。要让意图跨腿活下来,
 * 得先把它挪出 leg-specific 的 config,❌ 别在这里偷偷抄一份。
 */
function configForRuntime(
  config: SessionConfig,
  runtime: SessionRuntime,
  facts: { providerMintedSessionId: boolean }
): SessionConfig {
  const {
    initialPrompt: _initialPrompt,
    providerSessionEndpoint: _endpoint,
    ...rest
  } = config as SessionConfig & { initialPrompt?: string; providerSessionEndpoint?: string };
  if (runtime === 'pty') {
    const {
      initialQueue: _initialQueue,
      forkFromProviderSessionId: _forkFrom,
      mcpSessionServers: _mcpSessionServers,
      ...ptyRest
    } = rest as typeof rest & {
      initialQueue?: unknown;
      forkFromProviderSessionId?: string;
      mcpSessionServers?: string[];
    };
    return {
      ...ptyRest,
      version: '1',
      type: 'pty',
      ...(facts.providerMintedSessionId ? { providerMintedSessionId: true } : {}),
    } as SessionConfig;
  }
  return { ...rest, version: '1', type: 'acp' } as SessionConfig;
}
