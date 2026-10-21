import { resolveUnitDelivery } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  HarnessSessionSurface,
  ISessionBundleBehavior,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionPromptBlocks,
} from '@gugu/session-core/agents/plugins';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sessionMcpProtocolServers } from './session-mcp';

/**
 * 这次会话专属的 run-scoped 目录(`<GUGU_HOME>/runtime-sessions/<slug>/<uuid>`)—— 随目录消亡,
 * ❌ 不落进用户的工作区或这一家自己的配置根。拿不到 `GUGU_HOME` 就抛:那意味着调用方没给会话根,
 * 而把文件写到别处 = 在用户机器上留残留。
 */
export function sessionRunHome(bundle: SessionCapabilityBundle, adapterId: string, slug: string): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) {
    throw new Error(`${adapterId} session adapter requires bundle.env.GUGU_HOME`);
  }
  return join(guguHome, 'runtime-sessions', slug, randomUUID());
}

/** 平台块 + 身份块拼成的那段自述,以及实际送出了哪几块。一块都没有时是 `undefined`。 */
export function sessionPromptText(
  blocks: SessionPromptBlocks,
): { value: string; delivered: (keyof SessionPromptBlocks)[] } | undefined {
  const delivered = (['platform', 'identity'] as const).filter((key) => Boolean(blocks[key]));
  const value = delivered.map((key) => blocks[key]).join('');
  return value ? { value, delivered } : undefined;
}

/**
 * 走 `session-context` 载体的那段自述。⚠️ `carrier` 必须显式:缺席 = 静默回落系统位
 * (`_meta.systemPrompt.append`),对厂商原生 ACP server 是黑洞。
 */
export function sessionContextPrompt(blocks: SessionPromptBlocks) {
  const prompt = sessionPromptText(blocks);
  return prompt ? { ...prompt, carrier: 'session-context' as const } : undefined;
}

export const UNVERIFIED_SESSION_BUNDLE_DELIVERY = {
  kind: 'none',
  degraded: {
    code: 'unverified',
    reason: 'Session bundle delivery has not been verified for this adapter.',
  },
} as const;

function degraded(degradation: Degradation) {
  return { status: 'degraded' as const, reason: degradation };
}

export function createUnverifiedSessionBundleBehavior(
  adapterId: string,
  descriptor: SessionBundleDescriptor
): ISessionBundleBehavior {
  return {
    materialize(ctx): SessionMaterialization {
      if (!descriptor.surfaces.includes(ctx.surface)) {
        throw new Error(`Adapter '${adapterId}' does not declare session surface '${ctx.surface}'`);
      }
      // ⚠️ 一律经 `resolveUnitDelivery` 取这条腿上的那一格：按腿声明的家(`per-surface`)
      //    直接读 `.kind` 会恒不等于 'none'，把「这条腿其实什么都没投递」误判成「有 native」。
      const unit = (key: keyof SessionBundleDescriptor['units']) =>
        resolveUnitDelivery(descriptor.units[key], ctx.surface);
      if (
        unit('mcp').kind !== 'none' ||
        unit('env').kind !== 'none' ||
        unit('model').kind !== 'none' ||
        unit('autonomy').kind !== 'none' ||
        unit('promptBlocks').kind !== 'none' ||
        descriptor.extension.kind !== 'none'
      ) {
        throw new Error(
          `Adapter '${adapterId}' has native delivery and needs its own materializer`
        );
      }

      return {
        argsAppend: [],
        env: {},
        configMerges: [],
        artifacts: [],
        report: {
          adapterId,
          surface: ctx.surface,
          units: {
            mcp: unitReport(descriptor.units.mcp, ctx.surface),
            env: unitReport(descriptor.units.env, ctx.surface),
            model: unitReport(descriptor.units.model, ctx.surface),
            autonomy: unitReport(descriptor.units.autonomy, ctx.surface),
            promptBlocks: unitReport(descriptor.units.promptBlocks, ctx.surface),
            packages: degraded(descriptor.extension.degraded),
          },
          discoveredCommands: [],
        },
      };
    },
  };
}

function unitReport(
  delivery: SessionBundleDescriptor['units'][keyof SessionBundleDescriptor['units']],
  surface: HarnessSessionSurface
) {
  const leaf = resolveUnitDelivery(delivery, surface);
  return leaf.kind === 'native'
    ? { status: 'loaded' as const }
    : degraded(leaf.degraded);
}

function packageReport(extension: SessionBundleDescriptor['extension']) {
  return extension.kind === 'none'
    ? degraded(extension.degraded)
    : { status: 'loaded' as const };
}

/** Pure ACP wire rendering shared by exact harness adapters; it performs no provider selection. */
export function materializeAcpSessionBundle(
  adapterId: string,
  descriptor: SessionBundleDescriptor,
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
  options: {
    /**
     * 这条腿的 MCP **由调用方自己物化**(它声明的不是 `acp-session`)。
     *
     * ⚠️ 这不是把下面那道闸关掉,是把它**换个人守**:闸本身要问的是
     * 「声明了 native,可有人真去填吗」。默认没人填(本函数只会填 `acp.mcpServers`),
     * 所以默认要抛;调用方明确说「我填」时才让过 —— 而它填没填由
     * `delivery-paths-conformance` 那张卷子按 descriptor 逐格对账,躲不过去。
     * ❌ 别把它写成「忽略这一维」:那就真成了「声明了却没人送」的静默通过。
     */
    mcpMaterializedByProvider?: boolean;
  } = {}
): SessionMaterialization {
  if (!descriptor.surfaces.includes(ctx.surface)) {
    throw new Error(`Adapter '${adapterId}' does not declare session surface '${ctx.surface}'`);
  }
  const mcpDelivery = resolveUnitDelivery(descriptor.units.mcp, ctx.surface);
  const envDelivery = resolveUnitDelivery(descriptor.units.env, ctx.surface);
  if (
    mcpDelivery.kind === 'native'
    && mcpDelivery.channel !== 'acp-session'
    && !options.mcpMaterializedByProvider
  ) {
    throw new Error(`Adapter '${adapterId}' needs a non-ACP MCP materializer`);
  }
  // `acp-session` 的载体是 `session/new` 的 `mcpServers` —— **终端腿上没有这个东西**:
  // PTY 那条路只取 `argsAppend` / `env`(`main.ts` 的 session-TUI 分支),下面产出的 `acp` 载荷
  // 被整个忽略。而 `unitReport` 是**按 descriptor** 报数的,于是「声明了 acp-session」在
  // 两条腿上都恒定报 `loaded` —— 终端腿一个字节都没送,报告却说送到了。
  //
  // owner 2026-08-28 实测撞到:kimi 终端会话的能力报告写着 `mcp: loaded`,而机器上
  // `~/.kimi-code/mcp.json` 根本不存在,那条会话里咕咕的工具一个都没有。
  //
  // ⇒ 这里响亮失败,而不是悄悄降级:声明与投递不符要在**声明**那一侧改(改成按腿声明),
  //   不是在报告里补一句话。
  // ⚠️ 2026-08-28 修正:这道闸原来只看 `kind === 'native'`,而它的**话**说的是
  //    「你声明了 acp-session」。两者从前恒等(非 acp-session 的早被上一道闸拦掉了),
  //    现在不再等 —— 终端腿可以合法地声明 `config-file`(咕咕写自己那份配置文件)。
  //    只看 kind 会把一条**真送到了**的通道判成违规,而错误信息还指着一个它没声明的通道。
  //    ⇒ 判据跟着话走:只拦 `acp-session`。
  if (
    mcpDelivery.kind === 'native'
    && mcpDelivery.channel === 'acp-session'
    && ctx.surface !== 'acp'
  ) {
    throw new Error(
      `Adapter '${adapterId}' declares an 'acp-session' MCP delivery on surface '${ctx.surface}', `
        + 'where no session/new exists — declare this unit per-surface instead'
    );
  }
  if (envDelivery.kind === 'native' && envDelivery.channel !== 'child-process') {
    throw new Error(`Adapter '${adapterId}' needs a non-process environment materializer`);
  }

  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // 只有 `acp-session` 那条通道的载体是这份 `acp.mcpServers`;别的通道由各家自己物化
  // (kimi 终端腿写自己那份 mcp.json)。在这里也产一份 = 同一批 server 注册两遍。
  const mcpServers = mcpDelivery.kind === 'native' && mcpDelivery.channel === 'acp-session'
    ? sessionMcpProtocolServers(bundle, adapterId)
    : [];

  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }

  return {
    argsAppend: [],
    env,
    acp: { mcpServers },
    configMerges: [],
    artifacts: [],
    report: {
      adapterId,
      surface: ctx.surface,
      units: {
        mcp: unitReport(descriptor.units.mcp, ctx.surface),
        env: unitReport(descriptor.units.env, ctx.surface),
        model: unitReport(descriptor.units.model, ctx.surface),
        autonomy: unitReport(descriptor.units.autonomy, ctx.surface),
        promptBlocks: unitReport(descriptor.units.promptBlocks, ctx.surface),
        packages: packageReport(descriptor.extension),
      },
      discoveredCommands: [],
    },
  };
}
