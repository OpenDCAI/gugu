/**
 * 会话记录读侧的出口。
 *
 * ⚠️ 这个 barrel 是**宿主侧**的：`createSessionRecordSource` 往下拖 node:fs 与 better-sqlite3。
 * 渲染层 / 手机端只要契约里的类型，走
 * `@gugu/session-core/session-record/contract` 那条出口 —— 从这里取会把 node 依赖拖进浏览器包。
 */
export * from './contract';

export {
  createSessionTimeline,
  TIMELINE_ARCHIVE_VERSION,
  type SessionTimelineDeps,
  type TimelineArchive,
} from './timeline';

export {
  TRANSPORT_TEXT_LIMIT,
  trimAfterResultForTransport,
  trimBatchForTransport,
  trimItemsForTransport,
  trimOlderForTransport,
  trimSnapshotForTransport,
  trimTurnsForTransport
} from './transport-trim';

export { findToolImage, type ToolImageLookup } from './tool-image';

export {
  QUESTION_TOOL_NAMES,
  isQuestionToolName,
  readQuestion,
  type QuestionToolName,
  type RecordQuestion
} from './sources/question-tools';

export { permissionToPendingRequest } from './live-requests';

export {
  SessionRecordNotFoundError,
  type RecordSourceWarn,
  type SessionRecordSourceOptions
} from './sources/shared';

import type { SessionRecordLocator, SessionRecordSource } from './contract';
import { createClaudeJsonlSource } from './sources/claude-jsonl';
import { createCodexJsonlSource } from './sources/codex-jsonl';
import { createCopilotEventsSource } from './sources/copilot-events';
import { createHermesSqliteSource } from './sources/hermes-sqlite';
import { createOpencodeSqliteSource } from './sources/opencode-sqlite';
import { createQwenJsonlSource } from './sources/qwen-jsonl';
import { createPiJsonlSource } from './sources/pi-jsonl';
import type { SessionRecordSourceOptions } from './sources/shared';

/**
 * 按 locator 挑一家记录源。
 *
 * ❌ 没有"猜一家"的分支：locator 的 harness 是宿主按会话行解析出来的结论，
 * 读侧再猜一次只会让"三家之外"这件事变成一条静默走错路的分支，而不是一句
 * 「不支持」。三家之外由调用方在 `SessionpageSessionSummary.supported` 上如实标出来。
 */
export function createSessionRecordSource(
  locator: SessionRecordLocator,
  options?: SessionRecordSourceOptions
): SessionRecordSource {
  switch (locator.harness) {
    case 'claude':
      return createClaudeJsonlSource(locator, options);
    case 'codex':
      return createCodexJsonlSource(locator, options);
    case 'opencode':
      return createOpencodeSqliteSource(locator, options);
    case 'copilot':
      return createCopilotEventsSource(locator, options);
    case 'hermes':
      return createHermesSqliteSource(locator, options);
    case 'qwen':
      return createQwenJsonlSource(locator, options);
    case 'pi':
      return createPiJsonlSource(locator, options);
  }
}

export { questionAnswerError } from './question-answer';
