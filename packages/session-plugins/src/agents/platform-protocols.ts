// Browser-safe: 各家插件 `platform.ts` 声明的线协议,给渲染层(桌面/手机同一套 UI)按 agent 类型查。
// 与注册表同源(同一批 `harnessPlatform` 常量);`platform-protocols.test.ts` 钉住两边逐家相同。
import type { HarnessWireProtocol } from '@gugu/session-core/agents/plugins';
import { harnessPlatform as claude } from './impl/claude/platform';
import { harnessPlatform as codebuddy } from './impl/codebuddy/platform';
import { harnessPlatform as codex } from './impl/codex/platform';
import { harnessPlatform as copilot } from './impl/copilot/platform';
import { harnessPlatform as gemini } from './impl/gemini/platform';
import { harnessPlatform as hermes } from './impl/hermes/platform';
import { harnessPlatform as kimi } from './impl/kimi/platform';
import { harnessPlatform as mimocode } from './impl/mimocode/platform';
import { harnessPlatform as opencode } from './impl/opencode/platform';
import { harnessPlatform as pi } from './impl/pi/platform';
import { harnessPlatform as qoder } from './impl/qoder/platform';
import { harnessPlatform as qwen } from './impl/qwen/platform';
import { harnessPlatform as zcode } from './impl/zcode/platform';

export const PLATFORM_DECLARATIONS = {
  claude,
  codebuddy,
  codex,
  copilot,
  gemini,
  hermes,
  kimi,
  mimocode,
  opencode,
  pi,
  qoder,
  qwen,
  zcode,
} as const;

/** 这家发的协议;null = 没接平台模型(或不是插件 id)。 */
export function platformWireProtocol(engineId: string): HarnessWireProtocol | null {
  return Object.hasOwn(PLATFORM_DECLARATIONS, engineId)
    ? PLATFORM_DECLARATIONS[engineId as keyof typeof PLATFORM_DECLARATIONS].wireProtocol
    : null;
}
