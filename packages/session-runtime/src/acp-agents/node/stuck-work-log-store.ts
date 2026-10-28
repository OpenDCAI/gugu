import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 最多留几份;更旧的删掉。 */
export const STUCK_WORK_LOG_KEEP = 5;

/**
 * 兜底落定一轮时,把那条会话最近的原始 ACP 事件写到本机(账号数据目录的 logs/ 下)。
 * 里面有对话内容 ⇒ **只存本地**,❌ 上传;只留最近几份。文件名带时间和会话 id,按名字排序就是按时间。
 */
export function createStuckWorkLogStore(dir: string, logger: { warn: (message: string, meta?: Record<string, unknown>) => void }) {
  return (sessionId: string, rawLogJson: string): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
      writeFileSync(join(dir, `${stamp}-${safeId}.json`), rawLogJson, { mode: 0o600 });
      const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
      for (const name of files.slice(0, Math.max(0, files.length - STUCK_WORK_LOG_KEEP))) rmSync(join(dir, name), { force: true });
    } catch (error) {
      // 落不下来只少一份诊断,❌ 为它影响会话。
      logger.warn('stuck-work raw log could not be written', { sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
