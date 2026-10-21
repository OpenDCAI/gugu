import type { EmdashPlatformInjection } from '../emdash-platform-injector';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 平台注入信封落到 ACP start input 的**哪一格**,以及怎么与能力注入那份合并。
 *
 * 单独成一个纯函数而不是写在 host.ts 的三元里,理由与 `codexPlatformInjection` 那条一样:
 * 「送到了错的格子」是**静默**的 —— `sessionMeta` 是 `Record<string, unknown>`,把一份 spawn 环境
 * 放进去类型照过、会话照起,只是那几个变量永远到不了适配器进程。内联的那份没有测试够得到。
 *
 * ❌ 无 default 分支:新增一种信封时这里必须编不过,而不是静默走到一个「什么都不打的补丁」。
 */
export function trustedPlatformInputPatch(
  injection: EmdashPlatformInjection,
  capability: {
    sessionMeta?: Record<string, unknown>;
    spawnEnv?: Record<string, string>;
    spawnArgs?: string[];
  }
): Record<string, unknown> {
  switch (injection.kind) {
    case 'session-meta':
      return {
        platformAccessSessionId: injection.platformAccessSessionId,
        ...(injection.model ? { platformModel: injection.model } : {}),
        sessionMeta: mergeTrustedSessionMeta(capability.sessionMeta, injection.sessionMeta),
        ...(injection.adapterEnv
          ? { capabilitySpawnEnv: mergeTrustedSpawnEnv(capability.spawnEnv, injection.adapterEnv) }
          : {}),
      };
    case 'adapter-env':
      return {
        platformAccessSessionId: injection.platformAccessSessionId,
        platformModel: injection.model,
        capabilitySpawnEnv: mergeTrustedSpawnEnv(capability.spawnEnv, injection.spawnEnv),
        ...mergeTrustedSpawnArgs(capability.spawnArgs, injection.spawnArgs),
      };
    case 'adapter-spawn':
      return {
        platformAccessSessionId: injection.platformAccessSessionId,
        platform: injection.platform,
        platformModel: injection.platform.model,
      };
  }
}

export function stripUntrustedSessionAuthority<T extends Record<string, unknown>>(input: T): T {
  const stripped = { ...input };
  // 要续**哪一条 provider 会话** —— 这一格的属主是会话记录,不是渲染进程(#5869)。
  //
  // 别的几格剥掉是因为渲染进程**不该有权**给;这一格是因为它**给不准**:
  // `sessions.provider_session_id` 有多个写口,只有 `setSessionId` 会广播,于是渲染端那份会陈旧,
  // 而陈旧的 `null` 与「真的没有可续会话」在线上完全同形 ⇒ runtime 跳过 `session/load` 走
  // `session/new`,把一条有历史的会话悄悄换成空的(实测 4/4 必现)。
  // ⇒ 一律剥掉,由宿主从会话记录填回(`host.ts` 的 `facts.providerSessionId`)。
  delete stripped.providerSessionId;
  delete stripped.sessionMeta;
  delete stripped.platform;
  delete stripped.platformAccessSessionId;
  delete stripped.platformModel;
  delete stripped.sessionPrompt;
  delete stripped.mcpServers;
  delete stripped.capabilitySpawnEnv;
  delete stripped.capabilitySpawnArgs;
  delete stripped.forkSourceSession;
  delete stripped.runContext;
  return stripped;
}

/**
 * 能力注入与平台注入两份 spawn 环境的合并 —— `mergeTrustedSessionMeta` 的兄弟。
 *
 * **平台那份在上**,理由与 `_meta` 那边逐字相同:能力注入产出的是会话设施(`GUGU_HOME` 一族),
 * 平台注入产出的是这一轮的中转地址、令牌与模型钉定。反过来叠,一份陈旧的设施键就能把这次会话
 * 的模型钉定顶掉 —— 界面写着咕咕的模型、请求带着别的模型名,而会话令牌在网关上只白名单了一个。
 *
 * 两边都空 ⇒ 返回 `undefined` 而不是 `{}`；该 env 只承载本次会话的 spawn 输入，
 * 连接归属由 session-manager 按 conversation id 固定，不由 env 是否存在决定。
 */
export function mergeTrustedSpawnEnv(
  capabilityEnv: Record<string, string> | undefined,
  platformEnv: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!capabilityEnv) return platformEnv;
  if (!platformEnv) return capabilityEnv;
  return { ...capabilityEnv, ...platformEnv };
}

/**
 * 能力注入与平台注入两份 spawn argv 的合并,平台那份在后(同 env 的叠放顺序)。两边都空 ⇒ 不产出这一格。
 */
export function mergeTrustedSpawnArgs(
  capabilityArgs: readonly string[] | undefined,
  platformArgs: readonly string[] | undefined
): { capabilitySpawnArgs?: string[] } {
  const merged = [...(capabilityArgs ?? []), ...(platformArgs ?? [])];
  return merged.length > 0 ? { capabilitySpawnArgs: merged } : {};
}

export function mergeTrustedSessionMeta(
  capabilityMeta: Record<string, unknown> | undefined,
  platformMeta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!capabilityMeta) return platformMeta;
  if (!platformMeta) return capabilityMeta;
  const capabilityClaude = isRecord(capabilityMeta.claudeCode) ? capabilityMeta.claudeCode : {};
  const platformClaude = isRecord(platformMeta.claudeCode) ? platformMeta.claudeCode : {};
  const capabilityOptions = isRecord(capabilityClaude.options) ? capabilityClaude.options : {};
  const platformOptions = isRecord(platformClaude.options) ? platformClaude.options : {};
  const capabilityEnv = isRecord(capabilityOptions.env) ? capabilityOptions.env : {};
  const platformEnv = isRecord(platformOptions.env) ? platformOptions.env : {};
  const capabilityPlugins = Array.isArray(capabilityOptions.plugins) ? capabilityOptions.plugins : [];
  const platformPlugins = Array.isArray(platformOptions.plugins) ? platformOptions.plugins : [];
  return {
    ...capabilityMeta,
    ...platformMeta,
    claudeCode: {
      ...capabilityClaude,
      ...platformClaude,
      options: {
        ...capabilityOptions,
        ...platformOptions,
        ...(Object.keys(capabilityEnv).length > 0 || Object.keys(platformEnv).length > 0
          ? { env: { ...capabilityEnv, ...platformEnv } }
          : {}),
        ...(capabilityPlugins.length > 0 || platformPlugins.length > 0
          ? { plugins: [...capabilityPlugins, ...platformPlugins] }
          : {}),
      },
    },
  };
}
