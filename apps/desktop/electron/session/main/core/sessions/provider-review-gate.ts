import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type {
  ProviderBlocker,
  ProviderBlockerReason,
  ProviderReviewGate,
} from '@shared/core/sessions/sessionEvents';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { Terminal } from '@xterm/xterm';

const CLAUDE_MCP_REVIEW = /\b(?:new\s+mcp\s+servers?\s+found|use\s+this\s+mcp\s+server)\b/i;
const CLAUDE_NO_MCP_REVIEW = /\bno\s+new\s+mcp\s+servers?\s+found\b/i;

/**
 * spec provider-blocker:阻塞归哪一个活动态只在这两张表里声明,agent-hook-service 只读它们。
 * 「人点一下批准就继续」(MCP 审阅、工作区信任)= needs_user;要人去修东西(认证、账号、配置)= error。
 * `Record` 穷举 ⇒ 新增一种 reason / gate 而没在这里归类,编译就失败 —— ❌ 没有默认归类。
 */
export const PROVIDER_REVIEW_GATE_STATUS: Record<ProviderReviewGate, Extract<AgentStatus, 'needs_user' | 'error'>> = {
  mcp: 'needs_user',
};
export const PROVIDER_BLOCKER_STATUS: Record<ProviderBlockerReason, Extract<AgentStatus, 'needs_user' | 'error'>> = {
  'workspace-trust': 'needs_user',
  'hook-trust': 'needs_user',
  auth: 'error',
  account: 'error',
  config: 'error',
};

type ProviderBlockerCandidate = {
  providerIds: readonly AgentProviderId[];
  reason: ProviderBlockerReason;
  pattern: RegExp;
  guard?: (text: string) => boolean;
  message: (text: string) => string;
};

const PROVIDER_BLOCKERS: readonly ProviderBlockerCandidate[] = [
  { providerIds: ['qwen'], reason: 'config', pattern: /connect\s+(?:a|to)\s+provider\b/i, message: () => 'Connect a Provider' },
  {
    providerIds: ['mimocode'],
    reason: 'account',
    // Keep both locale forms: the provider's native blocker is Chinese on some installs and English on others.
    pattern: /(?:免费\s*API\s*服务已终止|(?:free\s+)?api\s+service[^\n]{0,120}\/login\b|\bMiMo\s+Token\s+Plan\b)/i,
    message: (text) => extractNativeBlockerText(text, /(?:服务已终止|api\s+service|MiMo\s+Token\s+Plan)/i)
      ?? 'Provider requires /login',
  },
  {
    providerIds: ['mimocode'],
    reason: 'workspace-trust',
    // MiMo 的工作区信任门(#4975):首装/新工作区时 TUI 停在这道必须有人回答的安全确认上,
    // 首句被它挡在提交之前。产品路径正常时它不该出现(WorkspaceTrustService 经 `--trust`
    // 预信任,见 impl/mimocode/trust.ts);出现即意味着 auto-trust 被关或预信任没走到 ——
    // 那正是必须显形的阻塞。门体完全本地化,标记穷举二进制里发行的全部 locale
    // (`strings <mimo> | grep '"trust.title"'`,0.1.8–0.1.14 一致),❌ 不许只写中文:
    // 英文界面机器上单语言标记恒不命中,是判不了假的判据。
    pattern: /(?:Accessing workspace|访问工作区|存取工作區|Accès à l'espace de travail|Accediendo al espacio de trabajo|Доступ к рабочему пространству|ワークスペースにアクセス中)/,
    // 标题词可能被后续输出引用;真正的门总是同屏渲染「是,信任」选项 —— 要求它同在。
    guard: (text) =>
      /(?:Yes, I trust this folder|是的[,，]我信任此目[录錄]|Oui, je fais confiance à ce dossier|Sí, confío en esta carpeta|Да, я доверяю этой папке|はい、このフォルダを信頼します)/.test(text),
    message: (text) => extractNativeBlockerText(
      text,
      /(?:Accessing workspace|访问工作区|存取工作區|Accès à l'espace de travail|Accediendo al espacio de trabajo|Доступ к рабочему пространству|ワークスペースにアクセス中)/,
    ) ?? 'Workspace trust confirmation required',
  },
  {
    providerIds: ['codex'],
    reason: 'hook-trust',
    // Codex 的 hook 信任审阅:一个还没审阅过的 hook(例如刚装的插件带的)让 TUI 在建出 / 载入 thread 之前停在这里,
    // 首句和之后的投递都进不去。完全访问档新建时由 `--dangerously-bypass-hook-trust` 免掉(codexTuiPermissionArgs);
    // 其余档、以及 `--remote … resume`(codex 不认那个参数)都要人来答。门体只有英文。
    pattern: /\bHooks need review\b/,
    // 标题可能被别的输出引用;真正的门同屏渲染「Trust all and continue」选项。
    guard: (text) => /\bTrust all and continue\b/.test(text),
    message: (text) => extractNativeBlockerText(text, /\bHooks need review\b/) ?? 'Hooks need review',
  },
  {
    providerIds: ['opencode'],
    reason: 'auth',
    // Require a complete normalized terminal line. TUI gutter/sidebar chrome is removed before matching.
    pattern: /(?:^|\n)\s*user\s+not\s+found\.?\s*(?:LSP)?\s*(?=\n|$)/i,
    // The provider's sidebar identifies this auth failure; a later script quoting the phrase does not.
    guard: (text) => /\bLSPs?(?:\s+are\s+disabled)?\b|\bOpenRouter\b|\b(?:auth|login|provider)\b/i.test(text),
    message: () => 'User not found.',
  },
];

const MAX_SCREEN_LINES = 64;
const MAX_PROVIDER_SCREEN_LINES = 512;
const MAX_DETECTION_BYTES = 32 * 1024;

function visibleTerminalText(terminal: Terminal, maxLines = MAX_SCREEN_LINES): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

function normalizeTuiText(text: string): string {
  return text
    .split('\n')
    .map((line) => line
      // xterm keeps full-screen box drawing and decoration glyphs in the text buffer.
      .replace(/[\u2500-\u257f\u2580-\u259f✦✧✶]/g, ' ')
      .trim())
    .join('\n');
}

function extractNativeBlockerText(text: string, marker: RegExp): string | null {
  const lines = normalizeTuiText(text).split('\n');
  const index = lines.findIndex((line) => marker.test(line));
  if (index < 0) return null;
  return lines
    .slice(index, index + 3)
    .filter(Boolean)
    .map((line) => line.replace(/\s+(?:LSPs?(?:\s+are\s+disabled)?|esc|sg:)\s*$/i, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

export function createProviderReviewGateDetector(
  onDetected: (gate: ProviderReviewGate) => void,
): (chunk: string) => void {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: MAX_SCREEN_LINES });
  let detected = false;

  return (chunk) => {
    if (detected) return;
    terminal.write(chunk, () => {
      if (detected) return;
      const text = visibleTerminalText(terminal);
      if (!CLAUDE_MCP_REVIEW.test(text) || CLAUDE_NO_MCP_REVIEW.test(text)) return;
      detected = true;
      terminal.dispose();
      onDetected('mcp');
    });
  };
}

export function createProviderBlockerDetector(
  onDetected: (blocker: ProviderBlocker) => void,
  providerId?: AgentProviderId,
): (chunk: string) => void {
  // Provider screens can interleave many delivery rows between an error and its sidebar context.
  // Keep a wider startup-only buffer so a later context marker can still explain that error.
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: MAX_PROVIDER_SCREEN_LINES });
  let detected = false;
  let bytesSeen = 0;

  return (chunk) => {
    if (detected || bytesSeen >= MAX_DETECTION_BYTES) return;
    bytesSeen += chunk.length;
    terminal.write(chunk, () => {
      if (detected || bytesSeen > MAX_DETECTION_BYTES) return;
      const text = normalizeTuiText(visibleTerminalText(terminal, MAX_PROVIDER_SCREEN_LINES));
      const match = PROVIDER_BLOCKERS.find((candidate) =>
        (!providerId || candidate.providerIds.includes(providerId))
        && candidate.pattern.test(text)
        && (candidate.guard?.(text) ?? true));
      if (!match) return;
      detected = true;
      terminal.dispose();
      onDetected({ kind: 'provider', reason: match.reason, message: match.message(text) });
    });
  };
}
