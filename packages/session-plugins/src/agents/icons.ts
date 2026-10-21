// Browser-safe icon assets shared by every agent surface. Provider runtime code stays on the host.
import type { PluginIconAsset } from '@gugu/session-shared/plugins';
import { icon as icon_amp } from './impl/amp/icon';
import { icon as icon_antigravity } from './impl/antigravity/icon';
import { icon as icon_auggie } from './impl/auggie/icon';
import { icon as icon_claude } from './impl/claude/icon';
import { icon as icon_cline } from './impl/cline/icon';
import { icon as icon_codebuff } from './impl/codebuff/icon';
import { icon as icon_codebuddy } from './impl/codebuddy/icon';
import { icon as icon_codex } from './impl/codex/icon';
import { icon as icon_commandcode } from './impl/commandcode/icon';
import { icon as icon_continue } from './impl/continue/icon';
import { icon as icon_copilot } from './impl/copilot/icon';
import { icon as icon_cursor } from './impl/cursor/icon';
import { icon as icon_devin } from './impl/devin/icon';
import { icon as icon_droid } from './impl/droid/icon';
import { icon as icon_gemini } from './impl/gemini/icon';
import { icon as icon_grok } from './impl/grok/icon';
import { icon as icon_hermes } from './impl/hermes/icon';
import { icon as icon_junie } from './impl/junie/icon';
import { icon as icon_kilocode } from './impl/kilocode/icon';
import { icon as icon_kimi } from './impl/kimi/icon';
import { icon as icon_kiro } from './impl/kiro/icon';
import { icon as icon_mimocode } from './impl/mimocode/icon';
import { icon as icon_mistral } from './impl/mistral/icon';
import { icon as icon_oh_my_pi } from './impl/oh-my-pi/icon';
import { icon as icon_opencode } from './impl/opencode/icon';
import { icon as icon_pi } from './impl/pi/icon';
import { icon as icon_qoder } from './impl/qoder/icon';
import { icon as icon_qwen } from './impl/qwen/icon';
import { icon as icon_zero } from './impl/zero/icon';
import { icon as icon_zcode } from './impl/zcode/icon';

export const agentIcons: Readonly<Record<string, PluginIconAsset>> = {
  'amp': icon_amp,
  'antigravity': icon_antigravity,
  'auggie': icon_auggie,
  'claude': icon_claude,
  'cline': icon_cline,
  'codebuff': icon_codebuff,
  'codebuddy': icon_codebuddy,
  'codex': icon_codex,
  'commandcode': icon_commandcode,
  'continue': icon_continue,
  'copilot': icon_copilot,
  'cursor': icon_cursor,
  'devin': icon_devin,
  'droid': icon_droid,
  'gemini': icon_gemini,
  'grok': icon_grok,
  'hermes': icon_hermes,
  'junie': icon_junie,
  'kilocode': icon_kilocode,
  'kimi': icon_kimi,
  'kiro': icon_kiro,
  'mimocode': icon_mimocode,
  'mistral': icon_mistral,
  'oh-my-pi': icon_oh_my_pi,
  'opencode': icon_opencode,
  'pi': icon_pi,
  'qoder': icon_qoder,
  'qwen': icon_qwen,
  'zero': icon_zero,
  'zcode': icon_zcode,
};
