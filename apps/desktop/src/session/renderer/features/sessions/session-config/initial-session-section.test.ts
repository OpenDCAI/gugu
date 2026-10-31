import type { ChatComposerProps, PromptEditorRef } from '@gugu/session-ui/react/components';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  dataClient: () => { throw new Error('Initial composer tests must not access the cloud'); },
}));
import {
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  type PlatformModelCatalogResponse,
  type PlatformModelOption,
} from '@shared/core/agents/platform-model';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';
// 弹窗走真 store（不 mock）—— 这样「点了去登录之后到底开了哪个窗」是**真**走了一遍
// `wrapArgs`（先关当前窗、再回调）的读数，而不是我自己摆的一个假通道。
import { modalStore } from '@renderer/lib/modal/modal-store';
import { buildInitialSession } from '../create-session-modal/build-create-session-params';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { runInAction } from 'mobx';
import { queryClient } from '@renderer/lib/query-client';
import {
  InitialSessionField,
  resolvePlatformModel,
  sessionpageLegForCreation,
  terminalLegUnstartableForCreation,
  useInitialSessionState,
  type InitialSessionState,
} from './initial-session-section';
import { effortSourceFor, platformEffortFacts, resolveCreateEfforts, resolveEffortCatalog } from '@shared/core/agents/create-efforts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  setProviderOverride: vi.fn(),
  invoke: vi.fn(),
  /** 访达拖进来的那条真路径;粘贴进来的是空串(Chromium 给不出路径)。 */
  droppedPath: '',
  /** 那台机器(dev-ssh)上那一份:新建会话页的附件必须落在它那儿(#6264)。 */
  remoteCommitAttachment: vi.fn(async (input: { name: string }) => ({
    success: true as const,
    data: { id: 'r1', storedPath: `/remote/${input.name}`, mentionPath: `/remote/${input.name}`, name: input.name, size: 1 },
  })),
  rpcCommitAttachment: vi.fn(
    async (input: { sessionId: string; name: string; originalPath?: string }) => {
      const storedPath = `/u/task-attachments/${input.sessionId}/att-${input.name}`;
      return {
        success: true as const,
        data: {
          id: `att-${input.name}`,
          storedPath,
          originalPath: input.originalPath,
          mentionPath: input.originalPath ?? storedPath,
        },
      };
    }
  ),
  editorText: '',
  editorApi: {
    focus: vi.fn(),
    clear: vi.fn(),
    getText: vi.fn(() => mocks.editorText),
    setText: vi.fn((text: string) => {
      mocks.editorText = text;
    }),
    insertMention: vi.fn(),
    prependMention: vi.fn(),
    removeMention: vi.fn(),
    setMentionPending: vi.fn(),
  },
  lastChatComposerProps: null as unknown,
  navigate: vi.fn(),
  hostInstallNavigation: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@gugu/session-ui/react/components', () => ({
  // 底排渐进披露:这些用例验的是完整形态,所以这里恒回「还有地方」。
  // 收起形态另有真机取证;❌ 别在这里让它随档位变 —— 那会把两种形态混进同一批断言。
  useToolbarOutOfRoom: () => false,
  ChatComposer: (props: unknown) => {
    mocks.lastChatComposerProps = props;
    const { editorApiRef } = props as { editorApiRef?: React.Ref<PromptEditorRef> };
    if (typeof editorApiRef === 'function') {
      editorApiRef(mocks.editorApi as unknown as PromptEditorRef);
    } else if (editorApiRef) {
      editorApiRef.current = mocks.editorApi as unknown as PromptEditorRef;
    }
    return null;
  },
  // ⚠️ 这份 mock **整体替换**了那个入口,所以被测组件用到的每一个具名导出都得在这儿列出来 ——
  // 少一个不会让哪条断言变红,而是 render 期抛一条 unhandled error,整个文件的用例一起挂
  // (#5269 两次都撞在这儿:先是 formatAttachmentSize,后是附件预览这一格)。
  AttachmentViewerDialog: () => null,
  readAttachmentPreviewText: async () => undefined,
}));

// 文案回 key + 插值，断言看得见「取的是哪条 key」；❌ 只回 key 会让「说的是哪个 agent」验不到（把 name 换成别人照样绿）。
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    locale: 'zh-CN',
    translate: (key: string, values?: Record<string, string>) =>
      values && Object.keys(values).length ? `${key}|${Object.values(values).join('|')}` : key,
  }),
}));

// 平台模型目录走 preload 桥的裸 channel(M 侧注册 handler),测试从这里驱动它的成败。
vi.mock('@renderer/lib/electron-api', () => ({
  electronApi: () => ({ invoke: mocks.invoke, getPathForFile: () => mocks.droppedPath }),
}));

vi.mock('@renderer/lib/pty/terminal-image-injection', () => ({
  resolveDroppedFile: vi.fn(async (file: File) => `/tmp/${file.name}`),
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {},
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
  sidebarStore: {},
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: vi.fn(() => ({ projects: new Map() })),
  asMounted: vi.fn(() => undefined),
  getProjectStore: vi.fn(() => undefined),
  getProjectViewStore: vi.fn(() => undefined),
}));

vi.mock('@renderer/features/integrations/integration-icon', () => ({
  IntegrationIcon: () => null,
}));

vi.mock('@renderer/features/integrations/use-connected-issue-providers', () => ({
  useConnectedIssueProviders: () => ({
    connectedProviders: [],
    hasAnyIssueIntegration: false,
    isProviderUsable: () => false,
    isCheckingConnections: false,
  }),
}));

vi.mock('@renderer/features/library/prompts/use-prompt-library', () => ({
  usePromptLibrary: () => ({ value: [] }),
}));

vi.mock('@renderer/features/integrations/provider-logo', () => ({
  ProviderLogo: () => null,
}));

vi.mock('../create-session-modal/use-prompt-file-drop', () => ({
  usePromptFileDrop: () => ({ isDragOver: false, dropHandlers: {} }),
}));

vi.mock('../context-bar/add-context-popover', () => ({
  AddContextPopover: () => null,
}));

// @@@task-fusion (#2802) — 组件现在也读安装状态(没装的 agent 那一行点了要能开装)。
// 这个测试不套 QueryClientProvider,所以和隔壁 use-agents 一样把它 mock 掉。
// Keep these references stable across rerenders so a newly allocated query result does not
// invalidate the memoized options.
const agentFixtureRef = vi.hoisted(() => ({
  current: undefined as unknown[] | undefined,
  installing: new Set<string>(),
}));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatuses: () => ({ install: vi.fn() }),
  useInstallingAgents: () => agentFixtureRef.installing,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

// 模型清单已改为问 harness 自己（ACP `session/new` 的 configOptions[category=model]）。
// 这个测试同样不套 QueryClientProvider，所以和隔壁 use-agents 一样把它 mock 掉；回报的两条
// 与下面 fixture 里原本那两条等价，好让既有断言继续测它们本来在测的东西。
const READY_CATALOG = {
  kind: 'ready',
  models: [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  ],
  selected: null,
  // 档位与原 fixture 里模型自带的 effortIds 等价 —— 少了它，「选平台模型时强度控件照在」
  // 那条断言就测不到东西了（会因为没有档位可显示而平凡通过）。
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ],
  selectedEffort: 'high',
} satisfies HarnessCatalogState;

// 可改写：四态里只有 ready 有模型可选，另外三态要能在这里摆出来，否则「没装也不说为什么」
// 那个缺口（真机上抓到的）永远测不出。
const harnessCatalogRef = vi.hoisted(() => ({ current: null as unknown }));
/**
 * ⚠️ 参数是**真类型**,❌ 不是 `unknown`。
 *
 * 原来标 `unknown`,于是 2026-08-26 给 `auth-required` 加 `efforts`/`selectedEffort` 时,
 * 这里的旧形状 fixture 一声不吭地编过了,直到运行时 `state.efforts is not iterable` 才炸 ——
 * 一个本该由类型当场判死的漂移,变成了一条随机某个用例先撞上的红。
 */
function harnessCatalog(state: HarnessCatalogState) {
  harnessCatalogRef.current = state;
}

vi.mock('@renderer/lib/stores/use-harness-model-catalog', () => ({
  HARNESS_MODEL_CATALOG_QUERY_KEY: ['agents', 'modelCatalog'],
  useHarnessModelCatalog: () => ({
    state: harnessCatalogRef.current,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

// #4956 —— 自家默认这条路的凭据读数。默认 'unknown'(维持自家默认,与改动前一致);
// 要验凭据兜底的用例把它摆成 'uncredentialed'。同时收下入参,好断言问的是将要预选的那个模型。
const harnessCredentialRef = vi.hoisted(() => ({
  current: 'unknown' as 'credentialed' | 'uncredentialed' | 'unknown',
  lastArgs: null as { providerId: string | null | undefined; modelId: string | null | undefined } | null,
  refresh: undefined as unknown,
}));
vi.mock('@renderer/lib/stores/use-harness-model-credential', () => ({
  useHarnessModelCredential: (
    providerId: string | null | undefined,
    modelId: string | null | undefined
  ) => {
    harnessCredentialRef.lastArgs = { providerId, modelId };
    return {
      // 与真 hook 同一口径:没有 modelId 就没有读数 —— 恒 unknown。
      status: modelId ? harnessCredentialRef.current : 'unknown',
      refresh: (harnessCredentialRef.refresh ??= vi.fn()),
    };
  },
}));

vi.mock('@renderer/lib/stores/use-agents', () => ({
  useAgents: () => ({
    data: (agentFixtureRef.current ??= [
      {
        id: 'claude',
        name: 'Claude Code',
        // @@@task-fusion (#2802) — `status` 是 AgentPayload 的必填字段。vi.mock 的工厂不走
        // 类型检查,这份 fixture 从前漏了它。#6101 起 composer 分组读的是四态 `reading`
        // (去装 / 去修 / 重新选一份是三件不同的事),两格都要带。
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'supported' },
          // 声明了只读档才会有只读选项 —— claude 真实声明的就是这一份(`default` 是它的只读档)。
          autoApprove: {
            kind: 'supported',
            modes: {
              'read-only': { id: 'default', aliases: ['plan', 'dontAsk'] },
              edit: { id: 'acceptEdits' },
              'full-access': { id: 'bypassPermissions' },
            },
          },
          models: {
            kind: 'selectable',
            defaultModelId: 'claude-opus-4-8',
            modelOptions: {
              'claude-opus-4-8': { name: 'Claude Opus 4.8', effortIds: ['low', 'high'] },
              'claude-sonnet-5': { name: 'Claude Sonnet 5', effortIds: ['low', 'high'] },
            },
          },
          // 强度档位:composer 拿活目录给的 id 来这里查文案 —— 用来验「换模型来源不影响档位」。
          effort: {
            kind: 'selectable',
            effortOptions: { low: { name: '轻度' }, high: { name: '重度' } },
          },
          sessionpage: {
            'acp': { identity: 'addressable', messageTransport: 'router' },
            'tui': { identity: 'addressable', messageTransport: 'router' },
          },
        },
      },
      {
        id: 'cursor',
        name: 'Cursor',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'none' },
          autoApprove: { kind: 'none' },
          models: { kind: 'none' },
          effort: { kind: 'none' },
          sessionpage: {
            'tui': { identity: 'addressable', messageTransport: 'local-session' },
          },
        },
      },
      {
        // 登录可选的那一类:catalog 说 auth-required,但咕咕的模型照样能跑(vendorAccount
        // not-required)。Kimi 的 tui 身份腿保留在 descriptor 中,但 inbound:none 使它
        // 不可作为聊天页首句腿; renderer 应回退到 acp。
        id: 'kimi',
        name: 'Kimi',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'supported' },
          autoApprove: { kind: 'none' },
          models: { kind: 'none' },
          effort: { kind: 'none' },
          vendorAccount: { kind: 'not-required', evidence: '只给 KIMI_MODEL_* 一族就跑得起来' },
          auth: {
            kind: 'supported',
            methods: [
              {
                kind: 'cli-login',
                id: 'kimi-login',
                name: 'Login with Kimi account',
                args: ['login'],
                description: 'Runs `kimi login`: a device-code sign-in…',
              },
            ],
          },
          sessionpage: {
            'acp': { identity: 'addressable', messageTransport: 'router' },
            'tui': { identity: 'addressable', messageTransport: 'local-session', inbound: 'none' },
          },
        },
      },
      {
        // 强制登录那一类:没有厂商账号什么都跑不起来(qoder 就是 P0 里唯一一家)。
        id: 'qoder',
        name: 'Qoder CLI',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'supported' },
          autoApprove: { kind: 'none' },
          models: { kind: 'none' },
          effort: { kind: 'none' },
          vendorAccount: { kind: 'required', evidence: '两条 BYOK 路都撞墙' },
          auth: {
            kind: 'supported',
            methods: [
              {
                kind: 'cli-login',
                id: 'qoder-login',
                name: 'Sign in to Qoder',
                args: ['login'],
                description: 'Runs `qodercli login`: opens your browser…',
              },
            ],
          },
          sessionpage: {},
        },
      },
      {
        // 强制登录、但**没有**命令行登录方式可声明的那一类 —— 阴性对照:
        // 「去登录」这个按钮只有在真能打开登录终端时才该出现。
        id: 'nologin',
        name: 'No Login CLI',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'supported' },
          autoApprove: { kind: 'none' },
          models: { kind: 'none' },
          effort: { kind: 'none' },
          vendorAccount: { kind: 'required', evidence: '给足三方 key 也起不来' },
          auth: { kind: 'none' },
          sessionpage: {},
        },
      },
      {
        // 能自动批准,但**没有**只读档 —— 大多数 harness 就是这样(argv 上只有一个
        // auto-approve 开关)。用来验「不给它摆一个不生效的只读档」。
        id: 'droid',
        name: 'Droid',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'none' },
          autoApprove: { kind: 'supported' },
          models: { kind: 'none' },
          effort: { kind: 'none' },
          sessionpage: {
            'tui': { identity: 'addressable', messageTransport: 'local-session' },
          },
        },
      },
      {
        // Kimi exposes both rows, but its tui row is not inbound-capable. The renderer must
        // therefore select ACP even when the stored Chat UI preference is off.
        id: 'opencode',
        name: 'OpenCode',
        status: 'available',
        reading: 'installed',
        capabilities: {
          acp: { kind: 'supported' },
          autoApprove: { kind: 'none' },
          models: { kind: 'none' },
          effort: {
            kind: 'selectable',
            effortOptions: {
              low: { name: 'low' },
              medium: { name: 'medium' },
              high: { name: 'high' },
            },
          },
          sessionpage: {
            'acp': { identity: 'addressable', messageTransport: 'router' },
          },
        },
      },
    ]),
  }),
}));

const GLM: PlatformModelOption = {
  id: 'glm-5.2',
  displayName: 'GLM 5.2',
  protocol: 'anthropic-messages',
  creditMultiplier: 0.7,
  contextWindow: 200_000,
  reasoningEfforts: ['low', 'high', 'max'],
  requiresMembership: false,
  hidden: false,
};

/** 倍率取不到的条目:UI 省掉数字,但仍要说清它按积分计费。 */
const QWEN_NO_MULTIPLIER: PlatformModelOption = {
  id: 'qwen-3-max',
  displayName: 'Qwen 3 Max',
  protocol: 'openai-responses',
  creditMultiplier: null,
  contextWindow: null,
  reasoningEfforts: null,
  requiresMembership: false,
  hidden: false,
};

/** 免费档用不了的会员模型(#7056):目录照列、标 `requires_membership`,下拉不列。 */
const OPUS_MEMBERS_ONLY: PlatformModelOption = {
  id: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  protocol: 'anthropic-messages',
  creditMultiplier: 12.5,
  contextWindow: 1_000_000,
  reasoningEfforts: ['low', 'high', 'max'],
  requiresMembership: true,
  hidden: false,
};

/** 他在设置「模型」页关掉的那一条(#7056):目录照列、标 `hidden`,下拉不列。 */
const GLM_HIDDEN: PlatformModelOption = { ...GLM, id: 'glm-5.3', displayName: 'GLM 5.3', hidden: true };

function platformCatalog(response: PlatformModelCatalogResponse) {
  mocks.invoke.mockImplementation((channel: string) =>
    channel === SESSIONPAGE_PLATFORM_CATALOG_CHANNEL
      ? Promise.resolve(response)
      : Promise.reject(new Error(`unexpected channel ${channel}`))
  );
}

vi.mock('@renderer/lib/ipc', () => {
  const mod = {
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    issues: {
      searchIssues: vi.fn(),
      getIssueContext: vi.fn(),
    },
    // 附件的字节在**任务建出来之前**就按块传好、落盘(#5269、#6264)。替身照真实的形状回两条路径:
    // `storedPath` = 我们自己那一份,`mentionPath` = 发给 agent 的那条(有原路径就是原路径)。
    sessionCreate: {
      writeAttachmentChunk: vi.fn(async () => ({ success: true as const, data: { received: 0 } })),
      commitAttachmentUpload: mocks.rpcCommitAttachment,
      discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
      recordAttachments: vi.fn(async () => ({ success: true as const, data: undefined })),
    },
  },
  };
  // #6264 一套工作台:按机器路由的那几个口,替身里都落到本机这一份。
  return {
    rpcOn: (machine: string | null) =>
      machine === 'dev-ssh'
        ? {
            ...mod.rpc,
            sessionCreate: {
              writeAttachmentChunk: vi.fn(async () => ({ success: true as const, data: { received: 0 } })),
              commitAttachmentUpload: mocks.remoteCommitAttachment,
              discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
            },
          }
        : mod.rpc,
    // 平台模型目录那一问经宿主通道走(本机 = electronApi().invoke)。
    invokeOnMachine: (_machine: string | null, channel: string, ...args: unknown[]) => mocks.invoke(channel, ...args),
    onMachineEvent: () => () => {},
    ...mod,
  };
});

vi.mock('@renderer/utils/logger', () => ({
  log: { warn: vi.fn() },
}));

// 新建会话的记忆在应用设置 `newSessionMemory`(这台设备一份,主进程的 spawnAgent 读同一份 —— L11 复核 58)。
// 替身:一份内存里的设置,update 合并、读的那一格跟着重画 —— 与 useAppSettingsKey 同一个形状。
const settingsStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let values: Record<string, unknown> = {};
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => { values = { ...values, [key]: value }; listeners.forEach((listener) => listener()); },
    /** A write that fails: the next updateAsync rejects with it (the settings store unavailable). */
    failure: null as Error | null,
    reset: () => { values = {}; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});
vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAppSettingsKey: (key: string) => ({
      value: useSyncExternalStore(settingsStore.subscribe, () => settingsStore.get(key)),
      update: (partial: Record<string, unknown>) => settingsStore.set(key, { ...((settingsStore.get(key) as object | undefined) ?? {}), ...partial }),
      updateAsync: async (partial: Record<string, unknown>) => {
        if (settingsStore.failure) throw settingsStore.failure;
        settingsStore.set(key, { ...((settingsStore.get(key) as object | undefined) ?? {}), ...partial });
      },
    }),
  };
});
// 新任务框给不给「终端 | 通用」跟本机开关(应用设置 terminal.enabled)走:同一份内存设置里的 `terminal`。
vi.mock('@renderer/features/settings/use-terminal-enabled', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useTerminalEnabled: () =>
      useSyncExternalStore(settingsStore.subscribe, () => (settingsStore.get('terminal') as { enabled?: boolean | null } | undefined)?.enabled === true),
  };
});
const EMPTY_MEMORY = { lastPicked: null, lastStarted: null, sessionView: 'code' as const };
/** What the box remembers, as a person who started it chose it unless the record says otherwise. */
function remember(lastStarted: Record<string, unknown>) {
  settingsStore.set('newSessionMemory', { ...EMPTY_MEMORY, ...(settingsStore.get('newSessionMemory') as object | undefined), lastStarted: { providerChosenByUser: true, ...lastStarted } });
}
const remembered = () => settingsStore.get('newSessionMemory') as { lastPicked: string | null; lastStarted: Record<string, unknown> | null; sessionView: string } | undefined;

// 那两条短时提示（读不到目录的原因 / 未登录但咕咕模型可用）走 toast —— 要断言「它带没带一条
// 去登录的路」，就得把 toast 收下来。❌ 不留真 sonner：它的 action 只活在 DOM 里，读不回来。
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
  useToast: () => ({ toast: mocks.toast }),
}));

/**
 * `noProviderSelected` = #5740 那个合法空态:本机一个可用 agent 都没有(或装了多家而定不出
 * 默认),composer 停在「还没选」。它不是错误,所以 `error` 仍是 null —— 判据靠 `providerId`。
 */
const effectiveProviderRef = vi.hoisted(() => ({ noProviderSelected: false }));

vi.mock('@renderer/features/sessions/use-effective-provider', () => ({
  // 真函数的解析顺序是「这一次的显式选择 → 上次启动过的那家 → …」;记忆自 #5973 起单独一格传进来,
  // 替身也得照这个顺序答,否则「上次用的是 pi」在这里会被答成 claude。
  useEffectiveProvider: (
    initialOverride?: string,
    _sessionpageSurface?: string,
    rememberedProviderId?: string | null
  ) => ({
    providerId: effectiveProviderRef.noProviderSelected
      ? null
      : (initialOverride ?? rememberedProviderId ?? 'claude'),
    setProviderOverride: mocks.setProviderOverride,
    createDisabled: effectiveProviderRef.noProviderSelected,
    chosenByUser: true,
  }),
}));

type InitialSessionOptions = Parameters<typeof useInitialSessionState>[3];

let latestState: InitialSessionState | undefined;

function Probe({
  autoApproveByDefault = false,
  projectId,
  options,
}: {
  autoApproveByDefault?: boolean;
  projectId: string;
  options?: InitialSessionOptions;
}) {
  latestState = useInitialSessionState(
    projectId,
    undefined,
    autoApproveByDefault,
    options
  );
  return null;
}

function FieldProbe({
  linkedIssue,
  includeIssueContextByDefault = false,
  placeholder,
  enableMentions,
  provider,
  creationSurface,
}: {
  linkedIssue?: LinkedIssue;
  includeIssueContextByDefault?: boolean;
  placeholder?: string;
  enableMentions?: boolean;
  /** 换一家 harness 来渲染 —— 登录那条链只在具体某一家身上才成立。 */
  provider?: string;
  creationSurface?: 'chat-page' | 'session-page';
}) {
  const state = useInitialSessionState(
    'project-1',
    provider as Parameters<typeof useInitialSessionState>[1],
    undefined,
    { creationSurface }
  );
  latestState = state;
  return React.createElement(InitialSessionField, {
    state,
    linkedIssue,
    includeIssueContextByDefault,
    enableMentions,
    placeholder,
  });
}

function chatComposerProps(): ChatComposerProps {
  if (!mocks.lastChatComposerProps) {
    throw new Error('ChatComposer was not rendered');
  }
  return mocks.lastChatComposerProps as ChatComposerProps;
}

/**
 * toolbarExtra 里最终出现的文字。
 *
 * ❌ 不用 `expect(toolbarExtra).toBeTruthy()`：那排里还挂着 Chat UI 开关，它本身就让整块非空 ——
 * 提示丢了照样绿。要断言的是「这句话在不在」，就得把节点真渲出来读文字。
 */
function toolbarText(): string {
  const host = document.createElement('div');
  const localRoot = createRoot(host);
  act(() => {
    localRoot.render(chatComposerProps().toolbarExtra as React.ReactNode);
  });
  const text = host.textContent ?? '';
  act(() => localRoot.unmount());
  return text;
}

/**
 * 工具栏那一排里,有没有哪个按钮点下去会打开登录终端。
 *
 * ⚠️ 为什么不直接断言那句「去登录」文案不出现:那个词表键(`harnessCatalog.signInAction`)
 * 已经随按钮一起删掉,系统**根本不会再吐这个词** —— 断言一个不存在的词不出现永远为真,
 * 是个恒绿的假守卫,谁把按钮加回来它也不会红(那时用的多半还是另一个新键)。
 * ⇒ 断言**行为**:这一排里不存在任何通向登录的路(它搬去了模型清单)。
 */
function toolbarOpensSignIn(): boolean {
  const host = document.createElement('div');
  const localRoot = createRoot(host);
  act(() => {
    localRoot.render(chatComposerProps().toolbarExtra as React.ReactNode);
  });
  let opened = false;
  for (const button of Array.from(host.querySelectorAll('button'))) {
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    if (modalStore.activeModalId === 'agentSignInModal') {
      opened = true;
      break;
    }
  }
  act(() => localRoot.unmount());
  return opened;
}

// #6447 —— 一条会话能选的推理档 = 这条调用链路真正兑现的档。平台模型的档由**该模型**在目录里认的那一组
// 与 harness 的清单取交集(网关对推理档是直通,上游各自校验);新建页(本组件)与会话内共用同一个 resolver。
describe('推理档目录:平台模型按模型取交集 (#6447)', () => {
  const six = {
    low: { name: 'Low' }, medium: { name: 'Medium' }, high: { name: 'High' },
    xhigh: { name: 'Extra high' }, max: { name: 'Max' }, ultra: { name: 'Ultra' },
  };
  const pick = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, six[id as keyof typeof six]]));
  // 目录里的真实取值(models.dev 2026-09-25 众数,与官方文档 / 实测一致)。
  const GLM_53 = { reasoningEfforts: ['low', 'high', 'max'] };
  const CLAUDE_OPUS_5 = { reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
  const create = {
    effortCapability: { kind: 'selectable' as const, effortOptions: six },
    staticModelsCapability: { kind: 'none' as const },
    model: null,
    leg: 'acp' as const,
  };
  // 本机探针说的是用户自家默认模型:两档、当前 high。
  const probe = {
    kind: 'ready' as const, models: [], selected: null,
    efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
    selectedEffort: 'high',
  };

  it('新建页:插件声明的六档按该模型收窄 —— GLM 只剩 low/high/max,不借自家探针的清单与默认档', () => {
    expect(resolveCreateEfforts({ ...create, state: probe, platformModel: GLM_53 }))
      .toEqual({ options: pick(['low', 'high', 'max']), defaultId: null });
  });

  it('GPT/Claude 这类到 max 的模型:xhigh / max 照样可选(#6199 的全局三档表曾把它们砍掉)', () => {
    expect(resolveCreateEfforts({ ...create, state: probe, platformModel: CLAUDE_OPUS_5 })?.options)
      .toEqual(pick(['low', 'medium', 'high', 'xhigh', 'max']));
  });

  it('harness 自己的档(codex 的 ultra)不在任何模型的目录里 ⇒ 平台模型上不出现', () => {
    const options = resolveCreateEfforts({ ...create, state: probe, platformModel: CLAUDE_OPUS_5 })?.options ?? {};
    expect(Object.keys(options)).not.toContain('ultra');
  });

  it('会话内:活清单 ∩ 该模型;模型不认的当前档不当默认', () => {
    const live = { options: six, defaultId: 'xhigh' };
    expect(resolveEffortCatalog({ options: six, defaultId: null }, live, 'platform', GLM_53.reasoningEfforts))
      .toEqual({ options: pick(['low', 'high', 'max']), defaultId: null });
    expect(resolveEffortCatalog(null, { options: six, defaultId: 'high' }, 'platform', GLM_53.reasoningEfforts))
      .toEqual({ options: pick(['low', 'high', 'max']), defaultId: 'high' });
  });

  it('会话内保留 harness 的 default 复位项,具体档仍按平台模型取交集', () => {
    const reset = { name: 'Default' };
    const live = { options: { default: reset, ...six }, defaultId: 'default' };
    expect(resolveEffortCatalog(null, live, 'platform', GLM_53.reasoningEfforts))
      .toEqual({ options: { default: reset, ...pick(['low', 'high', 'max']) }, defaultId: 'default' });
    expect(resolveEffortCatalog(null, { options: six, defaultId: null }, 'platform', GLM_53.reasoningEfforts))
      .toEqual({ options: pick(['low', 'high', 'max']), defaultId: null });
  });

  it('目录没有这条事实(null)或说没有这根轴(`[]`)⇒ 这个模型不画推理档,❌ 不拿一张全局表补', () => {
    expect(resolveCreateEfforts({ ...create, state: probe, platformModel: { reasoningEfforts: null } })).toBeNull();
    expect(resolveCreateEfforts({ ...create, state: probe, platformModel: { reasoningEfforts: [] } })).toBeNull();
    expect(resolveEffortCatalog(null, { options: six, defaultId: 'high' }, 'platform', null)).toBeNull();
  });

  it('platformEffortFacts:按 id 从目录条目取;没选平台模型 = null,目录里查不到 = 档位 null', () => {
    const models = [{ id: 'glm-5.3', reasoningEfforts: GLM_53.reasoningEfforts }];
    expect(platformEffortFacts('glm-5.3', models)).toEqual(GLM_53);
    expect(platformEffortFacts('gone', models)).toEqual({ reasoningEfforts: null });
    expect(platformEffortFacts(null, models)).toBeNull();
  });

  it('声明了送不到网关的腿:平台模型那一格没有推理档;另一条腿与自有 key 不受影响', () => {
    const capability = { ...create.effortCapability, platformUndeliveredOn: ['acp' as const] };
    expect(effortSourceFor(true, capability, 'acp')).toBe('platform-undelivered');
    expect(resolveCreateEfforts({ ...create, effortCapability: capability, state: { kind: 'unsupported' }, platformModel: GLM_53 })).toBeNull();
    expect(resolveCreateEfforts({ ...create, effortCapability: capability, state: { kind: 'unsupported' }, platformModel: GLM_53, leg: 'tui' })?.options)
      .toEqual(pick(['low', 'high', 'max']));
  });

  it('[对照] 自有 key 的模型:harness 的整张目录原样', () => {
    expect(resolveCreateEfforts({ ...create, state: { kind: 'unsupported' }, platformModel: null })?.options).toEqual(six);
  });
});

describe('useInitialSessionState', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    latestState = undefined;
    mocks.droppedPath = '';
    harnessCatalog(READY_CATALOG);
    harnessCredentialRef.current = 'unknown';
    harnessCredentialRef.lastArgs = null;
    harnessCredentialRef.refresh = undefined;
    // 同上:空态是用例自己拨上去的,不还原就会漏给后面每一条。
    effectiveProviderRef.noProviderSelected = false;
    mocks.editorText = '';
    mocks.lastChatComposerProps = null;
    mocks.navigate.mockReset();
    // 默认:主进程没有这个 handler(M 侧尚未接线,或用户没登录)——目录取不到,分组缺席。
    mocks.invoke.mockRejectedValue(new Error('No handler registered'));

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost',
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    dom.window.localStorage.clear();
    settingsStore.reset();

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    // modalStore 是**进程级单例**:不清,上一条用例开的窗会活到下一条,
    // 于是「开了 agentSignInModal」可能是上一条留下的 —— 一条读上一次读数的断言。
    modalStore.closeModal();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
    runInAction(() => remoteHostsStore.hosts.clear());
  });

  async function renderProbe(
    projectId: string,
    options?: InitialSessionOptions,
    autoApproveByDefault = false
  ) {
    await act(async () => {
      root.render(React.createElement(Probe, { autoApproveByDefault, projectId, options }));
    });
  }

  async function setPrompt(prompt: string) {
    await act(async () => {
      latestState?.setPrompt(prompt);
    });
  }

  it('an explicit effort reset does not inherit the remembered level again', async () => {
    remember({
      provider: 'claude', model: 'claude-opus-4-8', effort: 'high',
    });
    await renderProbe('project-1');
    expect(latestState?.effort).toBe('high');
    await act(async () => { latestState?.setEffort(null); });
    expect(latestState?.effort).toBeNull();
    await act(async () => { latestState?.setPrompt('Keep the explicit default'); });
    expect(latestState?.effort).toBeNull();
    await latestState?.rememberStartedConfiguration();
    expect(remembered()?.lastStarted).not.toHaveProperty('effort');
  });

  // #5973 —— 出厂偏好猜出来的那家不许当「上次用过的」:替身的答案顺序是
  // `initialOverride ?? rememberedProviderId ?? 'claude'`,所以「记忆有没有被传下去」看得出来。
  it('does not carry over a provider the user never chose', async () => {
    remember({
      provider: 'codex', providerChosenByUser: false, permissionMode: 'edit',
    });
    await renderProbe('project-1');

    expect(latestState?.provider).toBe('claude');
  });

  // 阳控:同一条记录,只把来路改成「用户选的」,记忆就该被传下去。
  it('carries over a provider the user did choose', async () => {
    remember({
      provider: 'codex', providerChosenByUser: true, permissionMode: 'edit',
    });
    await renderProbe('project-1');

    expect(latestState?.provider).toBe('codex');
  });

  // #5973 —— 换项目只清「这个项目里写了什么」,❌ 不清「谁来干」:从前这里连 agent 一起清,
  // 于是点了 Claude、还没发送、切一下项目就退回出厂偏好。
  it('keeps the chosen agent when the project changes', async () => {
    await renderProbe('project-1');
    mocks.setProviderOverride.mockClear();

    await renderProbe('project-2');

    expect(mocks.setProviderOverride).not.toHaveBeenCalled();
  });

  // owner 2026-09-21 真机实遇:在项目首页把 Codex 改成 Claude,回到「新建任务」又变回 Codex。
  // 换页面 = 重新挂载,而「这一次的选择」是挂载态;点一下就要落盘,❌ 不能等到会话建起来。
  it('carries a manual pick across a remount of the composer', async () => {
    await renderProbe('project-1');
    await act(async () => { latestState?.setProvider('codex'); });
    expect((remembered()?.lastPicked ?? null)).toBe('codex');

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderProbe('project-2');

    expect(latestState?.provider).toBe('codex');
  });

  // 阴控:正在编辑一条已存记录(自动化)时,改的是那条记录的属性,❌ 不写进全局的「我上次选的」。
  it('does not record a pick made while editing a stored record', async () => {
    await act(async () => {
      root.render(React.createElement(FieldProbe, { provider: 'claude' }));
    });
    await act(async () => { latestState?.setProvider('codex'); });

    expect((remembered()?.lastPicked ?? null)).toBeNull();
  });

  it('resets the prompt by default when the project changes', async () => {
    await renderProbe('project-1');
    await setPrompt('Keep this for project one');

    expect(latestState?.prompt).toBe('Keep this for project one');

    await renderProbe('project-2');

    expect(latestState?.prompt).toBe('');
  });

  it('can preserve the prompt when the project changes', async () => {
    await renderProbe('project-1', { resetPromptOnProjectChange: false });
    await setPrompt('Keep this automation prompt');

    expect(latestState?.prompt).toBe('Keep this automation prompt');

    await renderProbe('project-2', { resetPromptOnProjectChange: false });

    expect(latestState?.prompt).toBe('Keep this automation prompt');
  });

  // 终端开关默认关:新会话走通用视角。
  it('defaults to the general view when the provider supports ACP', async () => {
    await renderProbe('project-1');

    expect(latestState?.sessionView).toBe('general');
  });

  // #6264 behavior「别的机器上的编程只给用 SSH 装上的机器」:创建框的展示选项按机器分。
  describe('别的机器上的新建会话', () => {
    /** 那台机器(名下有、连着);`directTerminal` = 用 SSH 装上的。 */
    function onMachine(deviceId: string, label: string, directTerminal: boolean) {
      runInAction(() =>
        remoteHostsStore.hosts.set(deviceId, {
          device: { id: deviceId, label, isOnline: true, platform: 'linux', lastSeenAt: null, sessionDigest: null, directTerminal },
          link: 'open',
          synced: true,
        })
      );
      return machineLibraryHost({ deviceId, deviceLabel: label, online: true, lastSeenAt: null });
    }

    async function renderRemote(directTerminal: boolean) {
      await act(async () => {
        root.render(
          React.createElement(
            LibraryHostProvider,
            { value: onMachine('dev-ssh', 'ssh 机', directTerminal) },
            React.createElement(Probe, { projectId: 'project-1' })
          )
        );
      });
    }

    it('只经云端连着的机器:钉在「通用」,控件说明为什么(编程要 SSH 直连)', async () => {
      await renderRemote(false);
      expect(latestState?.sessionView).toBe('general');
      expect(latestState?.sessionViewLock).toEqual({ view: 'general', reason: 'remote-needs-ssh' });
    });

    it('任务页在别的机器上开会话:附件与本机同一条通道,只是落在那台机器上', async () => {
      await renderRemote(true);
      expect(latestState?.machine).toBe('dev-ssh');
      expect(latestState?.attachments).toEqual([]);
    });

    it('附件贴上来就传到那台机器 —— ❌ 按预留的任务 id 选线落到本机(那个 id 哪台机器都还不认识)', async () => {
      await renderRemote(true);
      mocks.remoteCommitAttachment.mockClear();
      mocks.rpcCommitAttachment.mockClear();
      await act(async () => {
        await latestState?.enqueuePathAttachments([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
      });
      await act(async () => {
        expect(await latestState?.waitForPathAttachments()).toBe(true);
      });
      expect(mocks.remoteCommitAttachment).toHaveBeenCalledTimes(1);
      expect(mocks.rpcCommitAttachment).not.toHaveBeenCalled();
      expect(latestState?.pathAttachmentMentions()).toEqual(['@[notes.txt](/remote/notes.txt)']);
    });

    it('本机新建照常走本机附件通道', async () => {
      await renderProbe('project-1');
      expect(latestState?.machine).toBeNull();
    });

    it('在这台桌面上用 SSH 装上的机器:与本机一样两种都给,默认「通用」', async () => {
      await renderRemote(true);
      expect(latestState?.sessionViewLock).toBeNull();
      expect(latestState?.sessionView).toBe('general');
      await act(async () => {
        latestState?.setSessionView('code');
      });
      expect(latestState?.sessionView).toBe('code');
    });
  });

  it('scopes the inbound-none fallback to chat-page first turns', () => {
    const kimiSessionpage = {
      'acp': { identity: 'addressable' as const, messageTransport: 'router' as const },
      'tui': {
        identity: 'addressable' as const,
        messageTransport: 'local-session' as const,
        inbound: 'none' as const,
      },
    };

    const legFrom = (creationSurface: 'session-page' | 'chat-page') => sessionpageLegForCreation({
      sessionpage: kimiSessionpage,
      preferred: 'tui',
      terminalUnstartable: terminalLegUnstartableForCreation({
        sessionpage: kimiSessionpage, prompt: { kind: 'argv' }, creationSurface, dispatchesToChat: false,
      }),
    });
    expect(legFrom('session-page')).toBe('tui');
    expect(legFrom('chat-page')).toBe('acp');
  });

  // 派进群里的任务(项目里的新任务)首句是任务卡:终端腿要有吃得下消息首句的启动通道,
  // 与主进程起 pty 时那道闸同一个函数(providerTakesMessageStartupInPty)。
  it('locks Terminal for a dispatched task when the terminal leg cannot take the task card at startup', () => {
    const codexLike = {
      sessionpage: {
        'acp': { identity: 'addressable' as const, messageTransport: 'router' as const },
        'tui': { identity: 'addressable' as const, messageTransport: 'router' as const },
      },
      prompt: { kind: 'argv', startupDelivery: 'delivery-bridge' as const },
    };
    const unstartable = (prompt: typeof codexLike.prompt | { kind: string }, dispatchesToChat: boolean) =>
      terminalLegUnstartableForCreation({ sessionpage: codexLike.sessionpage, prompt, creationSurface: 'session-page', dispatchesToChat });

    expect(unstartable(codexLike.prompt, true)).toBe(true);
    expect(unstartable({ kind: 'argv' }, true)).toBe(false);
    // 不派任务(新建页)首句不是消息,codex 的终端照样可选。
    expect(unstartable(codexLike.prompt, false)).toBe(false);
  });

  it('a dispatching box shows Terminal locked to General with a reason when the agent cannot start there', async () => {
    settingsStore.set('terminal', { enabled: true });
    // 渲染一次让 fixture 落地,再改 claude 的启动通道声明。
    await renderProbe('project-1');
    const claude = (agentFixtureRef.current as Array<{ id: string; capabilities: { prompt?: unknown } }> | undefined)
      ?.find((agent) => agent.id === 'claude');
    const original = claude?.capabilities.prompt;
    try {
      claude!.capabilities.prompt = { kind: 'argv', startupDelivery: 'delivery-bridge' };
      await act(async () => root.unmount());
      root = createRoot(container);
      await renderProbe('project-1', { dispatchesToChat: true });
      expect(latestState?.sessionViewLock).toEqual({ view: 'general', reason: 'general-required-here' });
      await act(async () => { latestState?.setSessionView('code'); });
      expect(latestState?.sessionView).toBe('general');
      expect(buildInitialSession(latestState!)?.type).toBe('acp');

      claude!.capabilities.prompt = { kind: 'argv' };
      await act(async () => root.unmount());
      root = createRoot(container);
      await renderProbe('project-1', { dispatchesToChat: true });
      expect(latestState?.sessionViewLock).toBeNull();
      await act(async () => { latestState?.setSessionView('code'); });
      expect(buildInitialSession(latestState!)?.type).toBe('pty');
    } finally {
      claude!.capabilities.prompt = original;
    }
  });

  // owner 10-30:「允许以终端（TUI）模式启动 agent」关着,新任务一律通用、框里没有选择;
  // 开着,框里给「终端 | 通用」,默认通用,选终端建出来的是 pty。
  it('offers the Terminal / General choice only when the terminal switch is on', async () => {
    await renderProbe('project-1');
    expect(latestState?.sessionViewOffered).toBe(false);
    expect(latestState?.sessionView).toBe('general');
    expect(buildInitialSession(latestState!)?.type).toBe('acp');

    await act(async () => settingsStore.set('terminal', { enabled: true }));
    expect(latestState?.sessionViewOffered).toBe(true);
    expect(latestState?.sessionView).toBe('general');
    expect(buildInitialSession(latestState!)?.type).toBe('acp');

    await act(async () => { latestState?.setSessionView('code'); });
    expect(latestState?.sessionView).toBe('code');
    expect(buildInitialSession(latestState!)?.type).toBe('pty');
  });

  it('a stored record\'s own view (automations) overrides only this box, never a global setting', async () => {
    await renderProbe('project-1');

    await act(async () => {
      latestState?.setSessionView('code');
    });

    expect(latestState?.sessionView).toBe('code');
    expect(settingsStore.get('terminal')).toBeUndefined();
    expect(remembered()?.sessionView).toBeUndefined();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderProbe('project-2');

    expect(latestState?.sessionView).toBe('general');
  });

  // 「已安排」的编辑器与新建页是同一个 composer:咕咕那一组照样列出来、照样预选,选择随那条自动化
  // 存下、到点交给同一个翻译点。原来它把这一组关掉,工具栏上还自己编一句「咕咕模型尚未对 X 开通」——
  // 而那时咕咕的模型明明开着。
  it('offers the Gugu group on the unattended (scheduled) surface too', async () => {
    platformCatalog({ models: [GLM], agentDefault: { modelId: 'glm-5.2' } });

    await renderProbe('project-1', { unattended: true }, true);

    expect(latestState?.platformModels).toEqual([GLM]);
    expect(latestState?.platformModel).toBe('glm-5.2');
    expect(latestState?.platformNotice).toBeNull();
    expect(buildInitialSession(latestState!)?.platformModel).toEqual({ modelId: 'glm-5.2' });
  });

  // 选 harness 也是一次表态,载荷里要显式写 null —— 少了它主进程分不清「明确要 BYOK」和「没决策过」。
  it('writes an explicit null when the harness model is chosen', async () => {
    platformCatalog({ models: [GLM], agentDefault: { modelId: 'glm-5.2' } });
    await renderProbe('project-1');

    await act(async () => latestState?.setPlatformModel(null));

    expect(buildInitialSession(latestState!)).toHaveProperty('platformModel', null);
  });

  it('selects the provider default model instead of showing a generic model placeholder', async () => {
    await renderProbe('project-1');

    expect(latestState?.provider).toBe('claude');
    expect(latestState?.model).toBe('claude-opus-4-8');
  });

  it('persists a manual model only after that configuration starts a session', async () => {
    await renderProbe('project-1');

    await act(async () => {
      latestState?.setModel('claude-sonnet-5');
    });

    expect(latestState?.model).toBe('claude-sonnet-5');
    expect(remembered()?.lastStarted ?? null).toBeNull();

    await latestState?.rememberStartedConfiguration();
    expect(
      remembered()?.lastStarted ?? null
    ).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5',
      providerChosenByUser: true,
      permissionMode: 'edit',
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderProbe('project-2');

    expect(latestState?.model).toBe('claude-sonnet-5');
  });

  it('persists and restores the permission mode with the successful launch configuration', async () => {
    await renderProbe('project-1');

    await act(async () => latestState?.setPermissionMode('full-access'));
    expect(latestState?.permissionMode).toBe('full-access');
    expect(latestState?.autoApprove).toBe(true);
    expect(remembered()?.lastStarted ?? null).toBeNull();

    await latestState?.rememberStartedConfiguration();
    expect(
      remembered()?.lastStarted ?? null
    ).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      // 替身里这一格恒为 true:这几条用例测的是模型/权限档怎么落盘,不是 provider 的来路。
      providerChosenByUser: true,
      permissionMode: 'full-access',
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderProbe('project-2');

    expect(latestState?.permissionMode).toBe('full-access');
  });

  it('persists and restores read-only, the mode a boolean could never represent', async () => {
    await renderProbe('project-1');

    await act(async () => latestState?.setPermissionMode('read-only'));
    await latestState?.rememberStartedConfiguration();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderProbe('project-2');

    // ⚠️ 判据落在 permissionMode 上:autoApprove 对「只读」和「编辑」是同一个 false,
    // 只断言它的话,这条用例在档位退化回二值时照样绿。
    expect(latestState?.permissionMode).toBe('read-only');
    expect(latestState?.autoApprove).toBe(false);
  });

  // ⭐ #5597 —— 「草稿上显示的档 = 落库的档」在**聊天页**那一面。
  //
  // 之前这一面的决定不在 state 里:`buildInitialSession` 拿 `unattended` 无条件覆盖成
  // full-access,于是草稿显示只读、会话开出 bypassPermissions,而且不报错。
  // 现在这一面只保留一个**默认值**,选中值一律照选中的走。
  describe('聊天页草稿的权限档(#5597)', () => {
    it('默认是无人值守那一档 —— 那一面没有人守着答权限弹窗', async () => {
      // autoApproveByDefault=false:会话页此刻的默认是 edit ⇒ 读到 full-access 只可能来自
      // 聊天页那条分支,❌ 不可能是全局默认碰巧同值(否则这条用例证明不了任何事)。
      await renderProbe('project-1', { creationSurface: 'chat-page' }, false);

      expect(latestState?.permissionMode).toBe('full-access');
      expect(latestState?.autoApprove).toBe(true);
    });

    // 阴控:同一把判据在会话页那一面必须读到**别的**值。少了它,上一条在
    // 「creationSurface 整个没接上、两面都回落到同一个常量」时照样绿。
    it('阴控:同一份设置下任务页那一面不是 full-access', async () => {
      await renderProbe('project-1', { creationSurface: 'session-page' }, false);

      expect(latestState?.permissionMode).toBe('edit');
    });

    // 只列这家 fixture **真声明过**的档(claude 没声明 plan ⇒ 选 plan 会被既有的降档钳夹成
    // edit,那是另一条不变量,❌ 不要在这里混进来把判据搞成两件事)。
    it.each(['read-only', 'edit'] as const)(
      '在草稿上选 %s ⇒ state 就是它,❌ 不被无人值守默认顶掉',
      async (mode) => {
        await renderProbe('project-1', { creationSurface: 'chat-page' }, false);

        await act(async () => latestState?.setPermissionMode(mode));

        expect(latestState?.permissionMode).toBe(mode);
        expect(latestState?.autoApprove).toBe(false);
      },
    );

    // 聊天页不继承会话页那份「上次启动记住的档」:那是会话页的偏好(应用设置 newSessionMemory),
    // 让它决定一个无人值守面的默认值,等于用一次无关的选择改掉这一面的产品默认。
    it('不继承任务页记住的档', async () => {
      remember({ provider: 'claude', permissionMode: 'read-only' });

      await renderProbe('project-1', { creationSurface: 'chat-page' }, false);

      expect(latestState?.permissionMode).toBe('full-access');
    });
  });

  // 「已安排」到点自己开,也没人守着。它的表单不摆权限控件、主进程又只收无人值守那一档 ——
  // 原来它继承会话页记住的档,上次新建选过「编辑」的人在这里只看到一句红字「此智能体不支持无人值守」,
  // 存不了、也没有控件可改。
  describe('「已安排」的权限档', () => {
    it('默认无人值守,❌ 不继承任务页记住的档', async () => {
      remember({ provider: 'claude', permissionMode: 'edit' });

      await renderProbe('project-1', { unattended: true }, true);

      expect(latestState?.permissionMode).toBe('full-access');
      expect(latestState?.autoApprove).toBe(true);
    });

    // 阴控:同一份记录、同一个出厂默认,会话页那一面必须读到记住的那一档 —— 少了它,上一条在
    // 「unattended 根本没接上、记录也没读到」时照样绿。
    it('阴控:任务页那一面仍继承记住的档', async () => {
      remember({ provider: 'claude', permissionMode: 'edit' });

      await renderProbe('project-1', undefined, true);

      expect(latestState?.permissionMode).toBe('edit');
    });
  });

  it('uses the global default for an older record without a permission field', async () => {
    remember({ provider: 'claude', model: 'claude-opus-4-8' });

    await renderProbe('project-1', undefined, true);

    expect(latestState?.permissionMode).toBe('full-access');
  });

  // 摆一个不生效的档位,比少一个档危险得多:用户以为锁住了 agent,实际照跑不误。
  it('drops a remembered read-only when the agent has no such mode', async () => {
    remember({ provider: 'droid', permissionMode: 'read-only' });

    await renderProbe('project-1');

    expect(latestState?.provider).toBe('droid');
    expect(latestState?.permissionMode).toBe('edit');
  });

  it('does not restore Full access when the remembered provider lacks the capability', async () => {
    remember({ provider: 'cursor', permissionMode: 'full-access' });

    // 设置关着(默认 = edit):这样「错误地照 remembered 恢复 full-access」才读得出区别 ——
    // ladder-less 家的默认跟设置走之后,开着设置时默认本来就是 full-access,判据会失去分辨力。
    await renderProbe('project-1', undefined, false);

    expect(latestState?.provider).toBe('cursor');
    expect(latestState?.autoApprove).toBe(false);
    expect(latestState?.permissionMode).toBe('edit');
  });

  // ladder-less 家(autoApprove 阶梯没有、但 acp 腿有自治物化 —— kimi fixture 与 pi 同形)
  // 的会话页默认跟「默认自动批准」那颗设置走。#5608 曾把这一支硬编码 'edit',pi 于是默认
  // approval-required,每个工具弹一次 yes 卡,而设置开关对它完全失效(owner 2026-09-19 报障)。
  describe('ladder-less 家的任务页默认跟出厂设置走', () => {
    // 用 last-started 记录预选 provider(cursor/droid 用例同一条已被验证的路);
    // ❌ 不能走 state.setProvider —— 那个是转发给宿主的 override 回调,换不了草稿的 provider。
    // 记录里带 permissionMode:'edit' —— 它对 ladder-less 家必须被忽略,恰好多断言一层:
    // remembered 的 edit ❌ 不得压过设置开关给的那一档。
    const pickKimi = async (autoApproveByDefault: boolean) => {
      remember({ provider: 'kimi', permissionMode: 'edit' });
      await renderProbe('project-1', undefined, autoApproveByDefault);
    };

    it('设置开 ⇒ full-access(pi 不再逐工具询问)', async () => {
      await pickKimi(true);

      expect(latestState?.provider).toBe('kimi');
      expect(latestState?.permissionMode).toBe('full-access');
      // 阶梯不存在 ⇒ 旧布尔通道仍为 false:权限只由 permissionMode 表达。
      expect(latestState?.autoApprove).toBe(false);
    });

    it('阴控:设置关 ⇒ edit,开关对 ladder-less 家恢复含义', async () => {
      await pickKimi(false);

      expect(latestState?.permissionMode).toBe('edit');
    });
  });

  it('fails loud when the successful configuration cannot be persisted', async () => {
    await renderProbe('project-1');
    const persistenceError = new Error('storage unavailable');
    settingsStore.failure = persistenceError;
    try {
      await expect(latestState?.rememberStartedConfiguration()).rejects.toBe(persistenceError);
    } finally {
      settingsStore.failure = null;
    }
  });
});

describe('InitialSessionField', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    latestState = undefined;
    // ⚠️ 这一句原来**没有**,于是本 describe 的每个用例都继承上一个用例留下的目录状态 ——
    // 一直没出事,只因为在此之前没人在这里改过它,值恒是上一个 describe 的 beforeEach 留下的
    // READY_CATALOG。2026-08-26 加一条 `unavailable` 的用例,后面四条当场变红,
    // 而红的地方与那条用例毫无关系(「selectedModel 是 undefined」),看起来像别的 bug。
    // ⇒ 用例之间的独立性不能靠「没人碰过」。
    harnessCatalog(READY_CATALOG);
    harnessCredentialRef.current = 'unknown';
    harnessCredentialRef.lastArgs = null;
    harnessCredentialRef.refresh = undefined;
    // 同上:空态是用例自己拨上去的,不还原就会漏给后面每一条。
    effectiveProviderRef.noProviderSelected = false;
    mocks.editorText = '';
    mocks.lastChatComposerProps = null;
    // 默认:主进程没有这个 handler(M 侧尚未接线,或用户没登录)——目录取不到,分组缺席。
    mocks.invoke.mockRejectedValue(new Error('No handler registered'));

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost',
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    dom.window.localStorage.clear();
    settingsStore.reset();

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
    // 用例里挂上的「别的机器」只属于那一条:@ 弹层读这张表,留着就会多出一行「没读到」。
    runInAction(() => remoteHostsStore.hosts.clear());
  });

  async function renderField(props: React.ComponentProps<typeof FieldProbe> = {}) {
    await act(async () => {
      root.render(React.createElement(FieldProbe, props));
    });
    await act(async () => {});
  }

  /**
   * 清单口径:**acp 或 pty 任有一条可用即可**（owner 2026-08-28）。
   *
   * ⚠️ 这条 2026-08-28 之前钉的是相反的口径 —— 「按开关选出的那**一个** surface 过滤」，
   * 于是开关关着时只有协议腿的引擎整个从选择器里消失（owner 实测:kimi 看不到，且残留的选择
   * 还渲染出一句红字 `Agent "kimi" has no usable session-page integration for this session mode`）。
   * 那条用例把这个 bug 焊死了:它是绿的，而产品是坏的。
   *
   * ⇒ 现在两种开关状态下清单**相同**；开关的真实含义退回到「两条腿都能跑时优先用哪条」。
   * 反例对照:`qoder` 那个 fixture 的 `sessionpage` 是空的（两条腿都不可用），它在两种状态下都
   * **不该**出现 —— 没有它，「两边一样」可能只是因为过滤根本没在起作用。
   */
  /**
   * 只有聊天腿的引擎（opencode）：终端那一段灰掉是对的 —— 它没有终端腿。但选中的必须是
   * **聊天**，因为这条会话真的跑在聊天里。
   *
   * ⚠️ 这条钉的是一个真出过的形状：那一支曾经写死 `checked={false}`，于是用户看到的是
   * 「Chat UI 是关的，而且我还拨不动」——owner 2026-08-28 实测原话：
   * 「这里写死了,没法切换为 chatui,没法测」。控件的状态必须等于会话的真实形态。
   *
   * 反例对照在同一条里：claude / kimi 两条腿都有 ⇒ 两段都**选得动**。没有它，「灰掉」这一半
   * 可能只是因为控件对谁都不可用。
   */
  it('searches the live session_peers roster and keeps the canonical user target', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'sessionpage:session-peers') {
        return Promise.resolve([
          {
            sessionId: 'codex-conversation',
            engine: 'codex',
            identity: { users: { id: userId, display_name: 'Codex 1', gugu_number: null } },
          },
        ]);
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    Object.defineProperty(dom.window, 'electronAPI', {
      configurable: true,
      value: { invoke: mocks.invoke },
    });

    await renderField();
    const items = await chatComposerProps().mentionProvider!.search('codex');
    expect(items).toEqual([
      expect.objectContaining({
        id: `aid:${userId}`,
        label: `aid:${userId}`,
        name: 'Codex 1',
        role: 'agent',
      }),
    ]);
  });

  it('routes an uninstalled agent action to its agent detail in the library', async () => {
    await renderField();
    (window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = mocks.hostInstallNavigation;
    const props = chatComposerProps();
    act(() => {
      props.onAgentAction?.('claude');
    });
    expect(mocks.hostInstallNavigation).toHaveBeenCalledWith('claude');
    expect(mocks.navigate).toHaveBeenCalledWith('library', {
      tab: 'agents',
      agentId: 'claude',
    });
  });

  it('preserves the selected linked issue pill', async () => {
    const linkedIssue: LinkedIssue = {
      provider: 'linear',
      identifier: 'ENG-123',
      displayIdentifier: 'ENG-123',
      title: 'Fix flaky tests',
      url: 'https://linear.app/acme/issue/ENG-123/fix-flaky-tests',
    };

    await renderField({ linkedIssue, includeIssueContextByDefault: true });

    expect(mocks.editorApi.prependMention).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'issue:linear:ENG-123',
        label: 'issue:linear:ENG-123',
        name: 'ENG-123',
        kind: 'issue',
        description: 'Fix flaky tests',
      })
    );
  });

  it('keeps the linked issue out of the @ popup so only one owner inserts that pill', async () => {
    const linkedIssue: LinkedIssue = {
      provider: 'linear',
      identifier: 'ENG-123',
      displayIdentifier: 'ENG-123',
      title: 'Fix flaky tests',
      url: 'https://linear.app/acme/issue/ENG-123/fix-flaky-tests',
    };
    const userId = '22222222-2222-4222-8222-222222222222';
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'sessionpage:session-peers') {
        return Promise.resolve([
          {
            sessionId: 'codex-conversation',
            engine: 'codex',
            identity: { users: { id: userId, display_name: 'ENG-123 helper', gugu_number: null } },
          },
        ]);
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    Object.defineProperty(dom.window, 'electronAPI', {
      configurable: true,
      value: { invoke: mocks.invoke },
    });

    await renderField({ linkedIssue, includeIssueContextByDefault: true });

    // The query matches the issue by identifier AND title, so an issue item would show up here if
    // the popup still offered one. Only the local session comes back — the issue pill stays owned
    // by the prepend/remove effect, which is the only thing that knows whether the context is on.
    const items = await chatComposerProps().mentionProvider!.search('ENG-123');
    expect(items.map((item) => item.label)).toEqual([`aid:${userId}`]);
    expect(items.some((item) => item.kind === 'issue')).toBe(false);
  });

  async function selectModel(optionId: string) {
    const onModelChange = chatComposerProps().onModelChange;
    await act(async () => onModelChange?.(optionId));
  }

  // #4956 —— product spec「模型来源与 UI」的默认预选规则:自家默认这条路
  // 判得出无凭据时,新会话默认预选落到平台目录第一条(服务端 sort_order 的第一位)。
  describe('uncredentialed harness default (#4956)', () => {
    const SELECTED_READY = { ...READY_CATALOG, selected: 'claude-opus-4-8' };

    it('preselects the first platform model when the harness default has no credential', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [GLM, QWEN_NO_MULTIPLIER], agentDefault: null });

      await renderField();

      // 凭据读数问的必须是活目录自报的 selected —— 换一个 id 判出来的凭据不归属这条默认。
      expect(harnessCredentialRef.lastArgs).toEqual({
        providerId: 'claude',
        modelId: 'claude-opus-4-8',
      });
      expect(latestState?.platformModel).toBe('glm-5.2');
      expect(latestState?.model).toBeNull();
      expect(chatComposerProps().selectedModel).toBe('platform:glm-5.2');
    });

    it('keeps the harness default while the credential reading is unknown', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'unknown';
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBeNull();
      expect(chatComposerProps().selectedModel).toBe('claude-opus-4-8');
    });

    it('preselects the first platform model when the harness itself demands login', async () => {
      harnessCatalog({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null });
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBe('glm-5.2');
      expect(latestState?.model).toBeNull();
    });

    it('judges the remembered harness model, not the catalog default, and still rescues it', async () => {
      // 记录写在**会话创建成功**那一刻,证明不了模型调用真跑通(#4956 的死法正发生在创建之后
      // 的第一次调用)⇒ 恢复的模型同样要过凭据判读,❌ 不豁免。
      remember({ provider: 'claude', model: 'claude-sonnet-5' });
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();

      // 判读对象必须是将要预选的那个(恢复的 sonnet),❌ 不是目录自报的 selected(opus):
      // 只判 selected 会把一条明明有凭据的恢复路误改到平台,或反过来放走一条死路。
      expect(harnessCredentialRef.lastArgs).toEqual({
        providerId: 'claude',
        modelId: 'claude-sonnet-5',
      });
      expect(latestState?.platformModel).toBe('glm-5.2');
      expect(latestState?.model).toBeNull();
    });

    it('restores a remembered harness model whose credential reading is unknown', async () => {
      remember({ provider: 'claude', model: 'claude-sonnet-5' });
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'unknown';
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBeNull();
      expect(chatComposerProps().selectedModel).toBe('claude-sonnet-5');
    });

    it('lets an explicit harness model choice beat the credential fallback', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();
      expect(latestState?.platformModel).toBe('glm-5.2');
      await selectModel('claude-sonnet-5');

      // 选自家模型就是「这条会话不上平台」的表态 —— 兜底不再回来顶掉它。
      expect(latestState?.platformModel).toBeNull();
      expect(chatComposerProps().selectedModel).toBe('claude-sonnet-5');
    });

    it('falls back to nothing when the platform catalog is empty', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [], agentDefault: null });

      await renderField();

      // 平台目录空(没登录咕咕/引擎不入目录)时没有可落的点 —— 维持现状,❌ 不编一个 id。
      expect(latestState?.platformModel).toBeNull();
    });

    it('still rescues an uncredentialed default when the remembered platform model got delisted', async () => {
      // 记住的平台模型下架 ≠ 回到自家死路:那一档判不中要**继续往下走**到凭据兜底,
      // ❌ 不在「记录在但目录里没有」处定格成 null。
      remember({ provider: 'claude', platformModel: 'retired-model' });
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBe('glm-5.2');
      expect(latestState?.model).toBeNull();
    });

    // #7056 product spec:免费档的默认预选落在**他能用的**模型里排第一的那条,
    // ❌ 新用户第一句话就撞上「要会员」。目录把会员模型照列在前面也一样。
    it('skips members-only models when it falls back to the platform catalog', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [OPUS_MEMBERS_ONLY, GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBe('glm-5.2');
      expect(chatComposerProps().selectedModel).toBe('platform:glm-5.2');
    });

    it('does not reopen on a remembered model that now needs a membership', async () => {
      // 会员到期降回免费档:上次用的会员模型还记着,但它已经选不了 —— 往下走到凭据兜底。
      remember({ provider: 'claude', platformModel: 'claude-opus-5-5' });
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [OPUS_MEMBERS_ONLY, GLM], agentDefault: null });

      await renderField();

      expect(latestState?.platformModel).toBe('glm-5.2');
    });

    it('leaves members-only and hidden models out of the picker entirely', async () => {
      harnessCatalog(SELECTED_READY);
      platformCatalog({ models: [GLM, OPUS_MEMBERS_ONLY, GLM_HIDDEN], agentDefault: null });

      await renderField();

      // 下拉里只放点得中、跑得起来的(owner 2026-10-10:列着用不了的「像是埋雷」)——
      // 要会员的去设置「模型」页升级解锁,关掉的在那一页再打开。
      const ids = Object.keys(chatComposerProps().modelOptions ?? {});
      expect(ids).toContain('platform:glm-5.2');
      expect(ids).not.toContain('platform:claude-opus-5-5');
      expect(ids).not.toContain('platform:glm-5.3');
    });

    it('does not preselect a model he hid in settings', async () => {
      harnessCatalog(SELECTED_READY);
      harnessCredentialRef.current = 'uncredentialed';
      platformCatalog({ models: [GLM_HIDDEN, GLM], agentDefault: { modelId: 'glm-5.3' } });

      await renderField();

      expect(latestState?.platformModel).toBe('glm-5.2');
    });
  });

  it('carries a picked platform model into the create-task payload', async () => {
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField();
    await selectModel('platform:glm-5.2');

    expect(latestState?.platformModel).toBe('glm-5.2');
    const payload = buildInitialSession(latestState!);
    expect(payload?.platformModel).toEqual({ modelId: 'glm-5.2' });
    // 模型由网关签发的 token 钉死,harness 侧不再报一个与它打架的值。
    expect(payload?.model).toBeUndefined();
    expect(payload?.effort).toBeUndefined();
  });

  it('leaves platformModel off the payload when a harness model is picked', async () => {
    platformCatalog({ models: [GLM], agentDefault: { modelId: 'glm-5.2' } });

    await renderField();
    expect(latestState?.platformModel).toBe('glm-5.2');

    await selectModel('claude-sonnet-5');

    expect(latestState?.platformModel).toBeNull();
    expect(chatComposerProps().selectedModel).toBe('claude-sonnet-5');
    const payload = buildInitialSession(latestState!);
    expect(payload?.model).toBe('claude-sonnet-5');
    // 显式 null,不是缺席 —— 缺席留给「这条路径根本没有 composer」那一态。
    expect(payload).toHaveProperty('platformModel', null);
  });

  // Chat UI(ACP)与终端(pty)都能用「咕咕提供的模型」,所以这个开关只决定会话类型 ——
  // 它既不撤走分组,也不动已经选好的模型。
  it('keeps the platform group selectable while the general view is selected', async () => {
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField();
    await selectModel('platform:glm-5.2');
    expect(latestState?.platformModel).toBe('glm-5.2');

    await act(async () => latestState?.setSessionView('general'));

    expect(latestState?.platformModel).toBe('glm-5.2');
    // 选了平台模型就没有 harness 模型可言,acp 会话上同样如此。
    expect(latestState?.model).toBeNull();
    expect(chatComposerProps().selectedModel).toBe('platform:glm-5.2');
    expect(Object.keys(chatComposerProps().modelOptions ?? {})).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'platform:glm-5.2',
    ]);
    // 没有冲突可说了:这行字只留给目录本身取不到的情况。
    expect(latestState?.platformNotice).toBeNull();
    // acp 载荷照常带上三态字段 —— 被静默丢掉就等于「界面写着咕咕的模型、实际花用户自己的 Key」。
    const payload = buildInitialSession(latestState!);
    expect(payload?.type).toBe('acp');
    expect(payload?.platformModel).toEqual({ modelId: 'glm-5.2' });
  });

  // 上一条是「切过去的过程中」,这条是「一进来就停在通用视角」(终端开关关着):
  // 预选、分组、载荷都得与编程视角一致,而不是靠切一次才回来。
  it('offers the platform group when the composer opens in the general view', async () => {
    platformCatalog({ models: [GLM], agentDefault: { modelId: 'glm-5.2' } });
    settingsStore.set('terminal', { enabled: false });

    await renderField();

    expect(latestState?.sessionView).toBe('general');
    expect(latestState?.platformModel).toBe('glm-5.2');
    expect(chatComposerProps().selectedModel).toBe('platform:glm-5.2');
    expect(Object.keys(chatComposerProps().modelOptions ?? {})).toContain('platform:glm-5.2');
    const payload = buildInitialSession(latestState!);
    expect(payload?.type).toBe('acp');
    expect(payload?.platformModel).toEqual({ modelId: 'glm-5.2' });
  });

  it('leaves the platform pick untouched when switching back to the code view', async () => {
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField();
    await selectModel('platform:glm-5.2');
    await act(async () => latestState?.setSessionView('general'));
    await act(async () => latestState?.setSessionView('code'));

    expect(latestState?.platformModel).toBe('glm-5.2');
    expect(latestState?.platformNotice).toBeNull();
    expect(chatComposerProps().selectedModel).toBe('platform:glm-5.2');
    const payload = buildInitialSession(latestState!);
    expect(payload?.type).toBe('pty');
    expect(payload?.platformModel).toEqual({ modelId: 'glm-5.2' });
  });

  // 主进程给原因码,界面按码查文案表、❌ 原样转达原话(#6264 d22 / #6478 mac1)。
  it('says why the platform group is missing by reason code, not by relaying the raw reason', async () => {
    platformCatalog({ models: [], agentDefault: null, catalogError: 'gugu-models:runtime-not-connected' });

    await renderField();

    expect(latestState?.platformNotice).toBe('guguCatalog.reason.runtime-not-connected');
    expect(toolbarText()).toContain('guguCatalog.reason.runtime-not-connected');
    // 配置事实,重试不会变 ⇒ 不给重试。
    expect(latestState?.retryPlatformCatalog).toBeUndefined();
    expect(toolbarText()).not.toContain('harnessCatalog.retry');
    // 说出原因不等于阻断:harness 模型照常可选。
    expect(chatComposerProps().selectedModel).toBe('claude-opus-4-8');
  });

  it('shows an unreachable catalog as a retryable notice without the raw network error', async () => {
    // 宿主把 `net::ERR_PROXY_CONNECTION_FAILED` 这类原文只记日志,界面上只收到码。
    platformCatalog({ models: [], agentDefault: null, catalogError: 'gugu-models:unreachable' });

    await renderField();

    expect(latestState?.platformNotice).toBe('guguCatalog.reason.unreachable');
    const text = toolbarText();
    expect(text).not.toContain('net::');
    expect(text).toContain('harnessCatalog.retry');
    expect(latestState?.retryPlatformCatalog).toBeTypeOf('function');
  });

  // #137 owner 2026-10-23:「已经说了设备下线,这里有必要再说一个错误的提示吗」—— 目录是问那台机器要的,
  // 机器没连上时问不到是机器的事,由右下角机器的提示说;这一格 ❌ 再报「模型列表尚未就绪」+「重试」。
  it('says nothing about the platform catalog while the chosen machine is not connected', async () => {
    // 机器停了之后要过一会儿这边才知道:那段时间里问的那一次已经落成了「尚未就绪」。
    platformCatalog({ models: [], agentDefault: null, catalogError: 'gugu-models:host-not-ready' });
    const renderOn = async (online: boolean) => {
      await act(async () => {
        root.render(
          React.createElement(
            LibraryHostProvider,
            { value: machineLibraryHost({ deviceId: 'dev-off', deviceLabel: 'Mac 1', online, lastSeenAt: null }) },
            React.createElement(FieldProbe, {})
          )
        );
      });
      await act(async () => {});
    };
    await renderOn(true);
    expect(latestState?.platformNotice).toBe('guguCatalog.reason.host-not-ready');
    // 这边知道它没连上了:那句是机器离线的结果,不再说
    await renderOn(false);

    expect(latestState?.platformNotice).toBeNull();
    expect(latestState?.retryPlatformCatalog).toBeUndefined();
    expect(toolbarText()).not.toContain('guguCatalog.reason');
    expect(toolbarText()).not.toContain('harnessCatalog.retry');
  });

  it('never puts a raw server message on screen (#6264 d22: "model access server is not configured")', async () => {
    // 老版本宿主(或别的机器)把服务端原文塞进了原因那一格:认不出 ⇒ 说「暂时用不了」,旁边给重试;
    // ❌ 原话,也 ❌ 静默。
    platformCatalog({ models: [], agentDefault: null, catalogError: 'model access server is not configured' });

    await renderField();

    expect(latestState?.platformNotice).toBe('guguCatalog.reason.unknown');
    expect(toolbarText()).not.toContain('not configured');
    expect(latestState?.retryPlatformCatalog).toBeTypeOf('function');
  });

  it('defaults to the model the harness itself has selected', async () => {
    // 真机(mac1)抓到的第二个缺口,比第一个严重:下拉换成了活目录,默认值却还在读插件静态表。
    // 于是界面显示「Not selected」,而载荷里带的是 `claude-opus-4-8` —— 正是 claude 2.1.229
    // 不认、会把窗口回落成 200K 的那个 id,也就是 owner 最初报的那个 bug。
    harnessCatalog({
      kind: 'ready',
      models: [
        { id: 'default', name: 'Default (recommended)' },
        { id: 'opus[1m]', name: 'Opus (1M context)' },
      ],
      selected: 'opus[1m]',
      efforts: [],
      selectedEffort: null,
    });

    await renderField();

    expect(latestState?.model).toBe('opus[1m]');
    expect(buildInitialSession(latestState!)?.model).toBe('opus[1m]');
  });

  it('picks no model at all when the catalog never arrived', async () => {
    // 没有清单就是没有模型。❌ 不许从静态表捡一个用户看不见、也改不掉的 id 塞进载荷 ——
    // 交给 harness 用它自己的默认,那才是诚实的空。
    harnessCatalog({ kind: 'not-installed' });

    await renderField();

    expect(latestState?.model).toBeNull();
  });

  it('says why the model picker is empty instead of just showing "Not selected"', async () => {
    // 真机上抓到的缺口:mac1 没装 claude,composer 只显示一个「Model / Not selected」,
    // 不给任何理由。选择器为空是对的,沉默不是。
    harnessCatalog({ kind: 'not-installed' });

    await renderField();

    expect(chatComposerProps().modelOptions ?? {}).toEqual({});
    // 断的是「取了哪条 key、插了哪个 agent 名」—— 文案本体在词表里，两语由 messages 元测试守。
    expect(latestState?.harnessNotice).toBe('harnessCatalog.notInstalled|Claude Code');
    expect(toolbarText()).toContain('harnessCatalog.notInstalled');
    expect(toolbarText()).toContain('Claude Code');
  });

  it('stays silent about the model catalog while no agent is selected', async () => {
    // #5740 —— 「还没选 agent」是合法空态。那时根本没有目录要读,`harnessCatalogState` 恒停在
    // `unknown`,这一格若照常渲染就是一句永不结束的「正在读取可用模型…」。
    // 从前它被 providerError 顺带挡住(那时「没选」算一条错误),空态化之后必须自己挡。
    effectiveProviderRef.noProviderSelected = true;

    await renderField();

    expect(latestState?.harnessNotice).toBeNull();
    expect(toolbarText()).not.toContain('harnessCatalog.loading');
  });

  it('tells apart not-installed from needs-login', async () => {
    // ⚠️ 下面这些 authMethods fixture 只喂给 notice / 弹窗那一层，而那一层只读 `id` / `name`。
    // `kind` 取的是 schema 的**缺省值** `agent`（「无 `type` 即 agent」），
    // ❌ **不是**对该厂商真实方言的断言 —— 真实方言（qoder / kimi 实测都是 `terminal`）
    // 由 `tests/unit/desktop/electron/harnessModelCatalogAcp.test.ts` 钉。
    // 三种失败要给三句不同的话:该装的去装,该登录的去登录 —— 混成一句等于没说。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'oauth', name: 'OAuth', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });

    await renderField();

    expect(latestState?.harnessNotice).toBe('harnessCatalog.authRequiredWith|Claude Code|OAuth');
    expect(toolbarText()).toContain('harnessCatalog.authRequiredWith');
  });

  it('hands a needs-login harness a way to actually sign in, not just the news', async () => {
    // owner 2026-08-26 实测的缺口:咕咕说了「需要先登录(Login with Kimi account)」,
    // 然后就没有然后了 —— 一句陈述,没有下一步。这条断言钉的是「下一步存在,且它真的通向
    // 那个跑 `<cli> login` 的登录终端」。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'login', name: 'Login with Kimi account', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField({ provider: 'kimi' });

    // ⚠️ **2026-08-28 换了载体**:这条路从前挂在一条右下角 toast(「{name} 未登录」)上,
    //    现在挂在模型清单**里**的一组(渐进披露,owner 定;理由见组件那侧的
    //    `ComposerModelUnlock`)。断言跟着换到入口本身,不再断言那条已删除的 toast。
    const unlock = latestState?.harnessModelUnlock;
    // 先证明入口本身还在 —— 没有它,下面那句「点了会开登录终端」会平凡地对 undefined 为真。
    expect(unlock, '未登录时模型清单里那条「去登录」不见了').toBeTruthy();
    // translate 的 mock 把参数拼在 key 后面 —— 所以顺带钉住「这一组说的是**哪一家**」。
    // 组头与「登录之后」那一档共用同一个键 —— 同一档换内容不换标题。
    expect(unlock?.groupLabel).toBe('harnessCatalog.ownModelsGroup|Kimi');
    expect(unlock?.label).toBe('harnessCatalog.unlockModels|Kimi');

    // 反例对照:那条 toast 必须**真的没了** —— 只删渲染、判据仍绿的话这里会红。
    expect(
      mocks.toast.mock.calls.some(([arg]) =>
        (arg as { title?: string }).title?.startsWith('harnessCatalog.byokLoginOptional')
      ),
      '那条「未登录」toast 又回来了 —— 它对当下的任务没作用,是噪音'
    ).toBe(false);

    (window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = mocks.hostInstallNavigation;
    act(() => latestState?.harnessSignIn?.());

    /**
     * 真的走到了那条路 —— 现在的落点是**抽屉的「账号」行**(#6100),不再是这里自己弹的登录终端。
     * 入口的判据没变:这一条只对**自己声明了命令行登录方式**的家出现(kimi 声明了 kimi-login),
     * 那道闸在 `resolveSignInMethod`,阴控在下面那条「没声明 CLI 登录的家没有这条出路」。
     *
     * 两半缺一不可:外壳管顶层 tab,会话页管自己的资源库路由。
     */
    expect(mocks.hostInstallNavigation).toHaveBeenCalledWith('kimi');
    expect(mocks.navigate).toHaveBeenCalledWith('library', { tab: 'agents', agentId: 'kimi' });
    // 阴控:composer ❌ 不再自己开登录终端。
    expect(modalStore.activeModalId).not.toBe('agentSignInModal');
  });

  it('#6264 所选机器不是本机:「登录以使用」在那台机器上登录,❌ 跳本机资源库', async () => {
    // owner 2026-09-23 真机:远端选 Codex,点「登录以使用 Codex 模型」打开的是**本机**资源库的 Codex
    // (/opt/homebrew/bin/codex、「已登录」)—— 全是这台电脑的事。钉住:落点是登录窗口、目标是那台机器。
    harnessCatalog({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null });
    platformCatalog({ models: [GLM], agentDefault: null });
    runInAction(() =>
      remoteHostsStore.hosts.set('dev-walk', {
        device: { id: 'dev-walk', label: '走查机', isOnline: true, platform: 'linux', lastSeenAt: null, sessionDigest: null, directTerminal: false },
        link: 'open',
        synced: true,
      })
    );
    await act(async () => {
      root.render(
        React.createElement(
          LibraryHostProvider,
          { value: machineLibraryHost({ deviceId: 'dev-walk', deviceLabel: '走查机', online: true, lastSeenAt: null }) },
          React.createElement(FieldProbe, { provider: 'kimi' })
        )
      );
    });
    await act(async () => {});

    expect(latestState?.harnessModelUnlock?.label).toBe('harnessCatalog.unlockModels|Kimi');
    (window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = mocks.hostInstallNavigation;
    act(() => latestState?.harnessSignIn?.());

    expect(modalStore.activeModalId).toBe('agentSignInModal');
    const args = modalStore.activeModalArgs as {
      providerId: string;
      remote?: { deviceId: string; deviceLabel: string; headless: boolean; command: string };
      onClose: () => void;
    };
    expect(args.providerId).toBe('kimi');
    expect(args.remote).toMatchObject({ deviceId: 'dev-walk', deviceLabel: '走查机', command: 'kimi login' });
    // 本机那条路一步都没走。
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.hostInstallNavigation).not.toHaveBeenCalled();
    // 「去装」同理:远端没有跳本机资源库这一步。
    expect(chatComposerProps().onAgentAction).toBeUndefined();
    // 关窗(登没登成只有那台机器知道)⇒ 这一家的目录重问(那台机器那一份在同一前缀下)。
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => args.onClose());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents', 'modelCatalog', 'kimi'] });
    act(() => modalStore.closeModal());
  });

  it('tells a forced-login harness how to sign in, and does not claim Gugu models work', async () => {
    // qoder 那一家:没有厂商账号**什么都跑不起来**,咕咕的模型也一样。
    // ⇒ 弹窗给指引(「怎么登」+ 一条真通向终端的出口);❌ 不许同时冒出那句
    //   「咕咕自己的模型现在就能用」—— 那对这一家是假话。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'qoder-terminal', name: 'Login with Qoder', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField({ provider: 'qoder' });

    // ⚠️ 原来这里断言的是「那条 byok toast 没弹给 qoder」。那条 toast 2026-08-28 整个删了,
    //    照抄会变成一句**恒真**的空话。换成它真正守着的那件事:`byokLoginOptional` 对这一家
    //    必须仍为 false —— 它一旦被误判成 true,`harnessNoticeMessage` 就会被闭掉,
    //    工具栏上那句「需要先登录」会连同它一起消失。这一条能红。
    expect(toolbarText(), '强制登录那一家的行内说明不该被 byokLoginOptional 闭掉').toContain(
      'harnessCatalog.authRequiredWith'
    );

    expect(modalStore.activeModalId).toBe('harnessLoginRequiredModal');
    const args = modalStore.activeModalArgs as {
      harnessName: string;
      authMethods: string[];
      signInMethod: { id: string; description?: string } | null;
      onSuccess: (result: { action: string }) => void;
    };
    expect(args.harnessName).toBe('Qoder CLI');
    // 「怎么登」必须说得出来 —— 光有一个方法名(authMethods)只是换了个说法重复「需要登录」。
    expect(args.signInMethod?.id).toBe('qoder-login');
    expect(args.signInMethod?.description).toContain('qodercli login');

    (window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = mocks.hostInstallNavigation;
    act(() => args.onSuccess({ action: 'sign-in' }));

    // #6100:「去登录」把人送到抽屉的「账号」那一行,❌ 不在这里再弹一个登录终端。
    expect(mocks.hostInstallNavigation).toHaveBeenCalledWith('qoder');
    expect(mocks.navigate).toHaveBeenCalledWith('library', { tab: 'agents', agentId: 'qoder' });
    expect(modalStore.activeModalId).not.toBe('agentSignInModal');
  });

  it('offers no sign-in exit when the harness declares no CLI login', async () => {
    // 阴性对照。少了它,上面两条与「这个字段恒有值」同形 —— 一个永远为真的判据。
    // 控件要么真生效要么不渲染:开不了登录终端时,弹窗只剩「知道了」。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'oauth', name: 'OAuth', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });

    await renderField({ provider: 'nologin' });

    expect(modalStore.activeModalId).toBe('harnessLoginRequiredModal');
    expect(
      (modalStore.activeModalArgs as { signInMethod: unknown }).signInMethod
    ).toBeNull();
  });

  it('keeps the only way to sign in inside the model list, never in the toolbar', async () => {
    // 咕咕的模型这时**拿不到**（默认 invoke 就是 reject）⇒ 那句「需要先登录」占着工具栏。
    // 这一排里从前还并排着一枚「去登录」，owner 2026-09-05 令删：用咕咕提供的模型不需要登录
    // 任何一家，那颗按钮在用户扫一眼底排的那一刻与他要做的事无关；更硬的理由是它会退化成
    // **语义为空** —— 选了平台模型时那句状态被刻意闭掉、按钮却不受这个条件管，于是变成一个
    // 没有上下文的「去登录」贴在一个不需要登录的模型旁边（owner 截图报的正是这一格）。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'login', name: 'Login with Kimi account', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });

    await renderField({ provider: 'kimi' });

    // 阳性对照：那句状态确实还在这一排里 —— 否则下面「这一排点不出登录」平凡为真。
    expect(toolbarText()).toContain('harnessCatalog.authRequiredWith');
    expect(toolbarOpensSignIn(), '工具栏又长出一条通向登录的路了').toBe(false);

    // 而这条路本身必须存在，它搬去了模型清单里那一组。
    expect(latestState?.harnessModelUnlock, '路没了不等于搬走了').toBeTruthy();
    (window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
    }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = mocks.hostInstallNavigation;
    act(() => latestState?.harnessSignIn?.());
    // #6100:落点从「这里自己弹一个登录终端」改成抽屉的「账号」行 —— 登录终端只有一个主人。
    // ⚠️ 阴控在下面那行:composer ❌ 不再开任何弹窗。
    expect(mocks.hostInstallNavigation).toHaveBeenCalledWith('kimi');
    expect(mocks.navigate).toHaveBeenCalledWith('library', { tab: 'agents', agentId: 'kimi' });
    expect(modalStore.activeModalId).not.toBe('agentSignInModal');
  });

  it('puts no sign-in row in the model list when it has no login to offer', async () => {
    // 阴性对照。少了它，上面那条与「这一格恒有值」同形。
    // ❌ 摆一个点了打不开任何东西的「去登录」——控件要么真生效要么不渲染。
    harnessCatalog({
      kind: 'auth-required',
      authMethods: [{ id: 'oauth', name: 'OAuth', kind: 'agent' }],
      efforts: [],
      selectedEffort: null,
    });

    await renderField({ provider: 'nologin' });

    // 阳性对照：那句状态照说 —— 「没有下一步」不等于「什么都不说」。
    expect(toolbarText()).toContain('harnessCatalog.authRequiredWith');
    expect(latestState?.harnessSignIn).toBeNull();
    expect(latestState?.harnessModelUnlock, '清单里摆了一条点不开的死行').toBeNull();
  });

  it('offers no sign-in for the other three catalog states', async () => {
    // 「该去装」与「坏了可重试」各有各的去处 —— 共用这条路会把用户送去一个解决不了他问题的地方。
    harnessCatalog({ kind: 'not-installed' });
    await renderField({ provider: 'kimi' });
    expect(latestState?.harnessSignIn).toBeNull();

    harnessCatalog({ kind: 'unavailable', reason: 'boom' });
    await renderField({ provider: 'kimi' });
    expect(latestState?.harnessSignIn).toBeNull();
  });

  // #6692:读不到目录的原因从前只走 toast,而 <Toaster/> 只挂在会话页 —— 对话页「新建 Agent」用的是同一个
  // section,原因在那里无处可见。现在就地一行,两页一样;原文只取第一行、遮掉路径(与启动失败同一个口径)。
  it('says why the harness catalog could not be read right under the composer, not in a toast', async () => {
    harnessCatalog({
      kind: 'unavailable',
      reason: 'Hermes is not connected to any AI provider yet. Run `hermes model` in /Users/me/.hermes\n    at probe (catalog.ts:12)',
    });
    await renderField({ provider: 'kimi' });

    expect(latestState?.harnessNotice).toContain('harnessCatalog.unavailable');
    const line = container.querySelector('[data-testid="harness-catalog-failure-detail"]');
    expect(line?.textContent).toBe('Hermes is not connected to any AI provider yet. Run `hermes model` in [path]');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('drops the harness notice once a platform model is picked', async () => {
    // 平台模型的会话根本不经过本机 harness,这时再说「尚未安装 Claude Code」是句噪音。
    harnessCatalog({ kind: 'not-installed' });
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField();
    await selectModel('platform:glm-5.2');

    expect(latestState?.platformModel).toBe('glm-5.2');
    expect(latestState?.harnessNotice).toBeNull();
    expect(toolbarText()).not.toContain('harnessCatalog.');
  });

  it('stays quiet when the request itself never got through', async () => {
    // 默认 invoke 就是 reject —— 我们编不出用户看得懂的原因,那就不说。
    await renderField();

    expect(latestState?.platformNotice).toBeNull();
  });

  it('remembers a started platform model so the next composer opens on it', async () => {
    platformCatalog({ models: [GLM], agentDefault: null });

    await renderField();
    await selectModel('platform:glm-5.2');
    await latestState?.rememberStartedConfiguration();

    expect(
      remembered()?.lastStarted ?? null
    ).toEqual({
      provider: 'claude',
      platformModel: 'glm-5.2',
      // 权限档跟着**出厂默认**走,不是这条用例的被测对象(它测的是「记住的平台模型能不能
      // 原样带回下一次 composer」)。
      providerChosenByUser: true,
      permissionMode: 'full-access',
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderField();

    expect(latestState?.platformModel).toBe('glm-5.2');
  });
});


describe('first-use model defaults (#7582)', () => {
  const ds = { ...GLM, id: 'deepseek-v4.1-flash' };
  const luna = { ...GLM, id: 'gpt-6-luna' };
  const catalog = { models: [GLM, ds, luna], agentDefault: null, sessionSelection: undefined, catalogError: null };

  it('selects each engine’s own default even when it is not first in the catalog', () => {
    expect(resolvePlatformModel(catalog, 'claude', undefined, null, false)).toBe(ds.id);
    expect(resolvePlatformModel(catalog, 'codex', undefined, null, false)).toBe(luna.id);
  });

  it('keeps explicit choices and prior platform or credentialed own-model choices', () => {
    expect(resolvePlatformModel(catalog, 'claude', null, null, false)).toBeNull();
    expect(resolvePlatformModel(catalog, 'claude', GLM.id, null, false)).toBe(GLM.id);
    expect(resolvePlatformModel(catalog, 'claude', undefined, { provider: 'claude', platformModel: GLM.id, providerChosenByUser: true }, false)).toBe(GLM.id);
    expect(resolvePlatformModel(catalog, 'claude', undefined, { provider: 'claude', model: 'sonnet', providerChosenByUser: true }, false)).toBeNull();
    expect(resolvePlatformModel({ ...catalog, agentDefault: { modelId: GLM.id } }, 'claude', undefined, null, false)).toBe(GLM.id);
  });

  it('never preselects hidden or restricted factory models', () => {
    for (const blocked of [{ ...ds, hidden: true }, { ...ds, requiresMembership: true }]) {
      const restricted = { ...catalog, models: [blocked, GLM] };
      expect(resolvePlatformModel(restricted, 'claude', undefined, null, false)).toBeNull();
      expect(resolvePlatformModel(restricted, 'claude', undefined, null, true)).toBe(GLM.id);
    }
  });

  it('uses the free default when Claude’s preferred model is unavailable', () => {
    expect(resolvePlatformModel({ ...catalog, models: [luna] }, 'claude', undefined, null, false)).toBe(luna.id);
  });
});
