import {
  isLevelEnabled,
  prepareFields,
  resolveLogLevel,
  type LogLevel,
} from '@gugu/session-shared/logger';
import { rendererLogger } from '@/lib/log';

const level = resolveLogLevel({ envLevel: import.meta.env.VITE_LOG_LEVEL });

// 会话页的日志和主渲染层走同一条路:`log:write` → 主进程 → `gugu-main.log`,scope `renderer/sessionpage`;
// 没有 Electron 桥(网页目标)时 rendererLogger 自己退回 console。从前那条 `emdash:renderer-log` 通道自 08-03
// 起主进程就没人听(接收方随旧的会话页 main 入口一起删了),warn / info 一行都没落过盘。
const sink = rendererLogger('sessionpage');

function emit(target: LogLevel, input: unknown[]): void {
  if (target !== 'error' && !isLevelEnabled(target, level)) return;
  const [first, ...rest] = input;
  const args = (typeof first === 'string' ? rest : input).map((v) => prepareFields(v));
  sink[target](args.length > 0 ? { args } : {}, typeof first === 'string' ? first : '');
}

export const log = {
  level,
  debug: (...input: unknown[]) => emit('debug', input),
  info: (...input: unknown[]) => emit('info', input),
  warn: (...input: unknown[]) => emit('warn', input),
  error: (...input: unknown[]) => emit('error', input),
};
