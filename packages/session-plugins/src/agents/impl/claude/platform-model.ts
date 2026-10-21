import {
  trimmedValue,
  type IPlatformModelBehavior,
  type PlatformModelLoad,
} from '@gugu/session-core/agents/plugins';
import { claudePlatformModelOption } from '@gugu/session-core/acp/platform-model-address';
import { harnessPlatform } from './platform';

/**
 * `--settings` 的**文档内容** —— 把这次会话的中转地址与令牌钉在**高于用户 settings 文件**的那一层。
 *
 * 为什么必须走 argv 而不是只导出环境变量:Claude Code 的设置优先级是
 * 「Managed > 命令行参数 > 项目 local > 项目 > 用户 `~/.claude/settings.json`」,而用户 settings 里的
 * `env` 块**在启动时被写进进程环境**——也就是说它盖得住我们 spawn 前导出的任何东西。真机实测:用户
 * settings 里存着自己的 `ANTHROPIC_BASE_URL`,平台会话于是带着咕咕的模型名打到用户自己的网关
 * (nginx 日志上我们的中转一次请求都没收到),而积分这边已经预留 —— 正是 spec 禁止的「界面写 A、实际跑 B」。
 *
 * ⚠️ `env` 是**逐键合并**的,不是整块覆盖:我们写下的键赢,没写的键从用户 settings 落下来
 * (claude 2.1.223 实测)。所以这里只需要写咕咕真正要换的那几个键 —— ❌ 不要把用户那一块读进来
 * 再盖一遍:那既是多余的(`MAX_THINKING_TOKENS`、代理、自定义 `PATH` 本来就不会丢),又会把用户
 * 自己的 `ANTHROPIC_MODEL` 抬到这一层、反过来压住咕咕的模型钉扎。
 *
 * 咕咕要换的是打到哪(`ANTHROPIC_BASE_URL`)、用谁的票(`ANTHROPIC_AUTH_TOKEN`)、把用户自己的 Key
 * 压成空串(`ANTHROPIC_API_KEY`),以及模型钉扎与已知时的真实窗口。Key 压成空串而不是删掉,因为删掉
 * 之后进程环境里那份还会被用上。
 * 平台会话打开 Claude 的 gateway discovery。Claude Code 当前版在 `ANTHROPIC_MODEL` 已钉住且同时
 * 设置 `ANTHROPIC_CUSTOM_MODEL_OPTION` 时不会把 discovery 结果
 * 合入 ACP picker；因此把同一张 token-scoped 平台目录放进**临时会话文件**，让 adapter 在启动时
 * 看到全部平台 id。它不是用户 settings，也不改变用户 `availableModels`：adapter 的 SettingsManager
 * 仍从用户根读取该限制并在这张目录上继续过滤，Arm C 仍然 fail loud。
 *
 * 这两个字段各自有不可替代的职责（mac1，Claude Code 2.1.267 + claude-agent-acp 0.75.1）：
 * `modelPicker` 是 Claude Code 自己的可编排选单载体，接受 `options` 行的 `model`/`label`。
 * 平台会话使用 `replaceBuiltInOptions: true`，这样 native Default/Sonnet/Haiku 行不会混入平台 token
 * 的 picker；平台 alias 仍由 options 明确提供。Claude Code 2.1.267 的 `bin/claude.exe` 内嵌 settings schema
 * 明说它来自 managed、`--settings`/SDK 或 user（offset 77863484），并在 offset 77908640
 * 校验 `replaceBuiltInOptions`。`availableModels` 是另一道 whole-list allowlist：Claude Code
 * 仍对这些 picker rows 应用它；删除它时 19 行（含 native Opus/Sonnet）重新出现，平台 token
 * 就可能被拿去选 native 模型。`claude-agent-acp` 0.75.1 的 `dist/acp-agent.js:6172-6180`
 * 从 SettingsManager 取 `availableModels` 并调用 `applyAvailableModelsAllowlist`，
 * `:6870-6895` 再把过滤后的 `models.availableModels` 变成 ACP `configOptions`；同一文件 grep
 * `modelPicker`/`replaceBuiltInOptions` 为 0 次，说明 picker 字段由它透传给 Claude Code SDK，
 * 不是 adapter 自己的第二套选单。
 *
 * 关系要保持清楚：用户根 `~/.claude/settings.json.availableModels` 是 SettingsManager 的原生
 * 过滤来源，若排除平台 id，adapter 会保留该限制；会话文档的 `availableModels` 与
 * `replaceBuiltInOptions: true` 共同钉住这条平台会话应暴露的安全集合，子进程经 `--settings` 读到
 * `modelPicker` 的行/显示名后再受该集合约束。
 * 宿主的用户 allowlist 判据在 quota 前重复检查用户根并 fail loud；因此 Arm C 是
 * 「不换目录、不改用户文件、明确显示排除原因」，而不是用会话 allowlist 绕过用户选择。
 *
 * 用户自己的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 会照常落下来,这是**刻意的**(owner 2026-08-10 拍板):
 * 咕咕只负责纠正 harness 对窗口大小的**认知**(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`),至于在这个真窗口的
 * 哪个位置压缩,是用户自己的偏好,平台会话没有理由替他改。两者不冲突 —— 用户那个键被 harness 钳在真
 * 窗口以内(`Math.min`),所以纠正了认知之后,他的设置只会在正确的量程上生效。
 *
 * ❌ 这里**只产出文档,不产出 argv**:文档里有这次会话的中转令牌,而 `--settings` 的内联 JSON 形式会
 * 把它写进命令行 —— 同一个文件里 `buildSocialBridge` 那条规矩说得很清楚:凭据只走环境,绝不进 argv,
 * 因为 argv 在进程表里人人可读。官方同时支持传**文件路径**(CLI reference:「a path to a settings JSON
 * file or an inline JSON string」),所以调用方把它写成一个 0600 的会话级文件再传路径。顺带也躲开了
 * Windows 上 cmd.exe 对内联 JSON 的引号转义(quoteForCmdExe 会把 `"` 变成 `^"`,在双引号内是字面量)。
 *
 * ❌ 绝不改用户的 settings 文件 —— 咕咕不碰用户的永久配置；这份文档只在会话存活期间存在。
 *
 * ⚠️ `replaceBuiltInOptions` + `availableModels` 裁掉的是**这条进程能跑什么**,
 * ❌ 不是「用户能选什么」:用户自己那几条仍然该出现在模型下拉里,点下去走重开会话换凭据
 * (渲染层 @@@own-model-tier + `planModelSwitch` 的 `reload`)。会话内菜单一度就是照这份被裁过的
 * 活清单画的,症状是平台 claude 会话里「你的 Claude 模型」整档消失(#5808)。
 */
function claudeSettingsOverride(
  platformSettingsEnv: Record<string, string> | undefined,
  selectedModel: string,
  platformModels?: readonly { id: string; displayName: string; contextWindow?: number | null }[],
  selectedWindow?: number | null,
): Pick<PlatformModelLoad, 'settingsOverride'> {
  if (!platformSettingsEnv || Object.keys(platformSettingsEnv).length === 0) return {}

  const normalizedModels = (platformModels ?? [])
    .map((entry) => ({ model: entry.id.trim(), label: entry.displayName.trim(), window: entry.contextWindow }))
    .filter((entry) => entry.model.length > 0 && entry.label.length > 0)
  const modelPicker = [
    {
      model: selectedModel,
      label: normalizedModels.find((entry) => entry.model === selectedModel)?.label ?? selectedModel,
      window: selectedWindow,
    },
    ...normalizedModels.filter((entry) => entry.model !== selectedModel),
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.model === entry.model) === index)
    // Each row is spelled the way Claude Code reads its window (claudePlatformModelOption). Both lists
    // below carry that one spelling: the ACP adapter re-keys a picker row onto the allowlist entry it
    // matches, so a bare allowlist id would pin the session back to the 200K spelling.
    .map((entry) => ({ model: claudePlatformModelOption(entry.model, entry.window), label: entry.label }))
  // The access token always authorizes the designated model. If the control plane does not
  // return a switchable_models list, keep that one alias as the complete safe set so Claude's
  // built-in native rows cannot ride the platform token to an unauthorized model.
  const availableModels = modelPicker.map((entry) => entry.model)

  return {
    settingsOverride: {
      // Whole-list safety boundary: adapter/Claude Code applies the user's higher-precedence
      // availableModels restriction on top of this session list; this removes native rows that
      // would send a platform token to an Anthropic model.
      availableModels,
      // Display/selectable rows: Claude Code's modelPicker supplies the platform ids and labels;
      // it is independent of the allowlist above, which is why both fields are intentional.
      modelPicker: { options: modelPicker, replaceBuiltInOptions: true },
      // Claude Code's own setting for restricted networks ("Skip the WebFetch blocklist check for enterprise
      // environments…"). Its preflight is an unauthenticated GET to api.anthropic.com/api/web/domain_info, which
      // answers 403 "Request not allowed" from regions Anthropic does not serve: through the gateway every WebFetch
      // failed with "Unable to verify if domain … is safe to fetch" (mac1 10-07: 6/6; with this key, it reads the
      // page). Only platform sessions get this document, so a user's own Claude account keeps its own setting.
      skipWebFetchPreflight: true,
      env: { ...platformSettingsEnv },
    },
  }
}

/**
 * claude 的 **Chat UI(ACP)** 注入信封 —— 和终端会话注入的是同样两样东西,只是换了送达方式。
 *
 * 终端会话:环境变量进 spawn env,settings 文档路径挂 `--settings` argv。
 * Chat UI:两样都塞进 `session/new` | `session/load` 的 `_meta`,因为咕咕在这条路上根本不 spawn
 * claude —— 是 ACP 适配器 spawn 的,而适配器会把 `_meta.claudeCode.options` **整包展开**进
 * Agent SDK 的 options(读适配器源码确认)。于是 `options.env` 盖过适配器自己的 process.env,
 * `options.settings` 就是 `--settings` 那一层。
 *
 * ❌ 不写 `settingSources`:适配器默认给的是 ["user","project","local"],也就是用户自己的配置照常
 * 加载 —— 这正是「平台会话 = 用户完整配置为底 + 只替换凭据与地址」这条原则。我们只往上盖三个凭据
 * 键(那是 settings 文档的事),❌ 不动他加载了哪些配置源。
 *
 * `settings` 传的是**路径**:SDK 把 `options.settings` 直接拼成 `--settings <值>` 交给 claude CLI,
 * 内联文档就等于把这次会话的中转令牌写进命令行,而 argv 在进程表里人人可读。
 */
export type ClaudeAcpPlatformSessionMeta = {
  claudeCode: {
    options: {
      settings?: string
      env: Record<string, string>
    }
  }
}

export function claudeAcpPlatformSessionMeta(input: {
  settingsDocumentPath: string | null
  env: Record<string, string>
}): ClaudeAcpPlatformSessionMeta {
  return {
    claudeCode: {
      options: {
        ...(input.settingsDocumentPath ? { settings: input.settingsDocumentPath } : {}),
        env: input.env,
      },
    },
  }
}

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_CLAUDE_MODEL'),
    // Carried even though this dialect emits no provider args: it is the signal that the
    // session is on platform quota at all, which is what decides whether the harness's own
    // model picker has to be repopulated from us.
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    // 同一张协议表说了算(❌ 不在这里另写一遍变量名):这一家就是 Anthropic 那一面,
    // 所以直接问协议表要「把一个 anthropic 协议的 harness 指向平台中转」的那组环境变量。
    // 用 platformAccess.relayUrl 而不是 platformProvider.baseUrl —— 后者带着 /v1。
    ...(input.platformAccess
      ? {
        platformSettingsEnv: input.protocolEnv(
          input.platformAccess.relayUrl,
          input.platformAccess.contextWindow,
        ),
      }
      : {}),
  }),
  load: (model) => {
    const selectedModel = trimmedValue(model.model)
    if (!selectedModel) return {}
    // 平台模型交给 Claude Code 的写法(1M 的 `claude-*` 带 `[1m]`,见 claudePlatformModelOption)。
    // 凡是告诉 Claude Code「这是哪个模型」的地方都用它:后台档若用规范 id,result.modelUsage 里就有
    // 两个键,适配器按前缀挑中 200K 那个去显示。
    const selectedOption = model.platformProvider
      ? claudePlatformModelOption(selectedModel, model.contextWindow)
      : selectedModel
    const spawnEnv: Record<string, string> = { ANTHROPIC_MODEL: selectedOption }
    // Claude Code's ANTHROPIC_BASE_URL "determines where requests go, but not which model
    // responds" — one endpoint for the whole process. Gateway discovery reads the relay's
    // token-scoped /v1/models, so the adapter can expose the complete platform catalog without
    // a product-owned availableModels filter. The session settings list supplies exact platform ids;
    // the custom-option alias remains for the resolver path, while modelPicker supplies exact rows.
    if (model.platformProvider) {
      spawnEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
      spawnEnv.ANTHROPIC_CUSTOM_MODEL_OPTION = selectedOption
      const customDisplayName = model.platformModels
        ?.find((entry) => entry.id.trim() === selectedModel)
        ?.displayName
        ?.trim()
      spawnEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = customDisplayName || selectedModel
      // Claude Code's background utility calls (session titles, command descriptions)
      // default to a built-in Haiku id unless the haiku tier is overridden. The session
      // token whitelists exactly one model and the relay serves no Anthropic-native ids,
      // so that default 403s mid-conversation. Pin the tier to the designated model —
      // both env names, since pre-2.x harnesses only read the deprecated one. A user
      // explicitly naming an unlisted model still fails loud; this only covers requests
      // the harness makes on its own.
      spawnEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = selectedOption
      spawnEnv.ANTHROPIC_SMALL_FAST_MODEL = selectedOption
    }
    // 模型钉扎必须与中转键同一层。`--settings` 的 `env` 逐键盖过用户 settings 与进程环境
    // (claude 2.1.223 实测:文档里没写的键会从用户 settings 落下来,写了的键赢)。只导 spawnEnv
    // 的话,用户自己 settings 里的 ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL 会赢 ——
    // 界面选着咕咕的模型,请求却带着用户的模型名,而会话令牌的白名单只有那一个模型,于是每个
    // 请求被网关拒。spawnEnv 照旧保留:不写文档的方言(以及没有平台凭据的会话)仍靠它。
    // ❌ 非平台会话不产出文档 —— 那会把 BYOK 用户自己选的模型也一起顶掉。
    const settingsEnv = model.platformSettingsEnv
      ? { ...model.platformSettingsEnv, ...spawnEnv }
      : undefined
    return {
      spawnEnv,
      ...claudeSettingsOverride(
        settingsEnv,
        selectedModel,
        model.platformModels,
        model.contextWindow,
      ),
    }
  },
};
