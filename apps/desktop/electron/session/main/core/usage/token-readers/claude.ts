import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asRecord,
  nonNegativeInt,
  timestampMs,
  type TokenEntry,
  type TokenLogReader,
} from './types';

/**
 * Claude Code:`<配置根>/projects/<转义后的 cwd>/<sessionId>.jsonl`,子 agent 的在
 * `<同目录>/<sessionId>/subagents/agent-*.jsonl`(子 agent 花的 token 也是这条会话花的)。
 *
 * 用量在 `type: 'assistant'` 行的 `message.usage`:
 *   input_tokens → input · output_tokens → output ·
 *   cache_read_input_tokens → cacheRead · cache_creation_input_tokens → cacheWrite。
 * 一条消息有几个内容块就写几行,每行都带着**同一份** usage ⇒ 按 `message.id` + `requestId` 去重
 * (与 ccusage 同口径);分叉/续接复制进新文件的历史行键也相同,全局去重同样挡住。
 */

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    // 目录不存在是常态(这台机器没装这一家 / 从没用过子 agent);别的错往上抛。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

export const claudeTokenReader: TokenLogReader = {
  provider: 'claude',

  async locate(configRoots, providerSessionIds) {
    const found = new Map<string, string[]>();
    for (const root of configRoots) {
      const projectsDir = join(root, 'projects');
      for (const project of await listDir(projectsDir)) {
        if (!project.isDirectory()) continue;
        const projectDir = join(projectsDir, project.name);
        for (const entry of await listDir(projectDir)) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const providerSessionId = entry.name.slice(0, -'.jsonl'.length);
            if (providerSessionIds.has(providerSessionId)) push(found, providerSessionId, join(projectDir, entry.name));
          } else if (entry.isDirectory() && providerSessionIds.has(entry.name)) {
            const subagentsDir = join(projectDir, entry.name, 'subagents');
            for (const sub of await listDir(subagentsDir)) {
              if (sub.isFile() && sub.name.endsWith('.jsonl')) {
                push(found, entry.name, join(subagentsDir, sub.name));
              }
            }
          }
        }
      }
    }
    return found;
  },

  initialState() {
    return null;
  },

  mayCarryUsage(line) {
    // 找**未转义**的结构标记:同样的字眼出现在对话正文 / 工具结果里时是转义过的(\"type\"),
    // 于是动辄几 MB 的工具结果行一律不进 JSON.parse。claude 写的是紧凑 JSON(无空格)。
    return line.includes('"type":"assistant"') && line.includes('"usage":{');
  },

  readLine(entry): TokenEntry | null {
    if (entry.type !== 'assistant') return null;
    const message = asRecord(entry.message);
    const usage = asRecord(message?.usage);
    if (!message || !usage) return null;
    const ts = timestampMs(entry.timestamp);
    if (ts === null) return null;
    const input = nonNegativeInt(usage.input_tokens);
    const output = nonNegativeInt(usage.output_tokens);
    const cacheRead = nonNegativeInt(usage.cache_read_input_tokens);
    const cacheWrite = nonNegativeInt(usage.cache_creation_input_tokens);
    if (input + output + cacheRead + cacheWrite === 0) return null;
    const messageId = typeof message.id === 'string' ? message.id : '';
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
    const key =
      messageId || requestId
        ? `claude:${messageId}:${requestId}`
        : `claude:line:${typeof entry.uuid === 'string' ? entry.uuid : `${ts}:${input}:${output}`}`;
    return {
      key,
      ts,
      model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
      input,
      output,
      cacheRead,
      cacheWrite,
    };
  },
};
