import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import { defaultHookEventParser } from '@gugu/session-core/agents/plugins/helpers';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { AgentEvent, AgentStatus } from '@shared/core/agents/agentEvents';
import { emptyStatusLogState, readStatusLog, stepStatusLog } from '../agent-status/status-event-log';
import { translateAgentEvent } from '../agent-status/status-event-translator';

/**
 * #6385 replay: status = the fold of the session's hook events through the product's parser, the status-event
 * translator and the reduce (the live path since #6448).
 * Fixture = 10 real copilot 1.0.82 session-page runs (bg: a background subagent finishes while the main turn
 * still runs; bgafter: it finishes after the main turn; sync: the main turn waits for it). Events are the
 * product-registered keys only, in arrival order, bodies as delivered.
 */
type Recorded = { hook: string; type: string; who: 'main' | 'subagent'; body: Record<string, unknown> };
type Run = { run: number; mode: 'bg' | 'bgafter' | 'sync'; events: Recorded[] };
const { runs } = JSON.parse(
  readFileSync(new URL('./fixtures/hook-sequences-6385.json', import.meta.url), 'utf8'),
) as { runs: Run[] };

type Parse = (eventType: string, body: Record<string, unknown>) => CanonicalHookEvent;
const copilotParse = pluginRegistry.get('copilot')!.behavior.hooks!.parseHookEvent! as Parse;

function replay(run: Run, parse: Parse) {
  const state = emptyStatusLogState();
  let status: AgentStatus = 'idle';
  return run.events.map((recorded) => {
    const before = status;
    const canonical = parse(recorded.type, recorded.body);
    if (canonical.kind === 'status') {
      const event: AgentEvent = {
        type: canonical.type,
        providerId: 'copilot',
        projectId: 'p',
        sessionId: 'c',
        timestamp: 0,
        payload: canonical.origin ? { origin: canonical.origin } : {},
      };
      const events = translateAgentEvent(event, {
        running: state.running,
        waiting: state.waits.size > 0,
        failed: state.error !== null,
        autoApproved: false,
      });
      for (const e of events) stepStatusLog(state, e, () => {});
      status = readStatusLog(state).status;
    }
    return { ...recorded, before, after: status };
  });
}

const subagentStops = (trace: ReturnType<typeof replay>) =>
  trace.filter((step) => step.hook === 'agentStop' && step.who === 'subagent');

describe('#6385 replay of 10 recorded copilot runs', () => {
  it('the fixture holds the runs the design was measured on', () => {
    expect(runs.map((run) => run.mode).sort()).toEqual(
      ['bg', 'bg', 'bg', 'bg', 'bgafter', 'bgafter', 'bgafter', 'sync', 'sync', 'sync'],
    );
    for (const run of runs) expect(subagentStops(replay(run, copilotParse))).toHaveLength(1);
  });

  it.each(runs.map((run) => [run.run, run.mode, run] as const))(
    'run %i (%s): the subagent stop never moves the status, and the run ends idle',
    (_n, mode, run) => {
      const trace = replay(run, copilotParse);
      for (const step of subagentStops(trace)) {
        expect(step.after, 'a subagent stop carries no status').toBe(step.before);
        if (mode !== 'bgafter') expect(step.after, 'the main turn is still running').toBe('working');
      }
      expect(trace.at(-1)?.after).toBe('idle');
    },
  );

  // Negative control: without the label (the default parser) the same recorded events drop the session to idle
  // while its own turn is still running — the bug, read by the same assertions.
  it.each(runs.filter((run) => run.mode !== 'bgafter').map((run) => [run.run, run.mode, run] as const))(
    'control run %i (%s): the unlabelled parser marks the running session idle at the subagent stop',
    (_n, _mode, run) => {
      const [step] = subagentStops(replay(run, defaultHookEventParser));
      expect(step?.before).toBe('working');
      expect(step?.after).toBe('idle');
    },
  );
});
