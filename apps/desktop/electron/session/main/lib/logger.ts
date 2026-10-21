import { createVariadicAdapter } from '@gugu/session-shared/logger';
import { initProcessLogging } from '@gugu/session-shared/logger/node';
import { getLogFileDestination } from './file-logger';

const inner = initProcessLogging({
  // 日志每一行的 `proc` 字段,用户翻 gugu-task.log 时逐行看得见。
  name: 'gugu-session',
  env: process.env,
  debugFlag: process.argv.includes('--debug-logs'),
  destination: getLogFileDestination(),
});

export const log = createVariadicAdapter(inner);

export type Logger = typeof log;
