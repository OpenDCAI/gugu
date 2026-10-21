import { claudeTokenReader } from './claude';
import { codexTokenReader } from './codex';
import type { TokenLogReader } from './types';

/**
 * 有 token 读取器的引擎。不在这里的(opencode、kimi、gemini …)token 记 0。
 * 加一家:在本目录加一个实现 TokenLogReader 的文件,登记进这张表。
 */
export const TOKEN_LOG_READERS: readonly TokenLogReader[] = [claudeTokenReader, codexTokenReader];

