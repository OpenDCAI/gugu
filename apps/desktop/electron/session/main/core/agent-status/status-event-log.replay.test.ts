import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reduceAgentStatus, type AgentStatusEvent } from './status-event-log';

/**
 * spec status-event-log —— 真机录下的 hook 序列回放(#6403)。
 *
 * 每个样本一步 = 一条原始 hook(摘要)→ 适配器该发的规范事件(`null` = 丢弃,`drop` 写明为什么)→ 期望状态。
 * 期望来自证据里写明的「对的行为」(#6377 / #6380 的 B 列、#6385、#6181、#6191 的读数),❌ 不是跑一遍 reduce 抄下来。
 */
interface ReplayStep {
  raw: string;
  event: AgentStatusEvent | null;
  drop: string | null;
  expect: string;
  finished: boolean;
}
interface ReplaySample {
  id: string;
  issues: string[];
  sessionId: string;
  expectAnomalies: number;
  steps: ReplayStep[];
}

const dir = join(__dirname, 'status-replay-samples');
const samples: ReplaySample[] = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as ReplaySample);

describe('reduceAgentStatus replays recorded hook sequences (#6403)', () => {
  it('has the samples the pilot requires', () => {
    const issues = new Set(samples.flatMap((s) => s.issues));
    for (const required of ['#6377', '#6385', '#6380', '#6191', '#6181']) expect(issues, required).toContain(required);
    expect(samples.filter((s) => s.id.startsWith('copilot-6385-run'))).toHaveLength(10);
  });

  for (const sample of samples) {
    it(`${sample.id} (${sample.issues.join(' ')})`, () => {
      const log: AgentStatusEvent[] = [];
      let last = reduceAgentStatus(sample.sessionId, log);
      sample.steps.forEach((step, i) => {
        if (step.event) log.push(step.event);
        last = reduceAgentStatus(sample.sessionId, log);
        const where = `step ${i} ${step.raw}`;
        expect(last.status, where).toBe(step.expect);
        if (step.event) expect(last.finished, `${where} (finished edge)`).toBe(step.finished);
      });
      expect(last.anomalies, sample.id).toHaveLength(sample.expectAnomalies);
    });
  }
});
