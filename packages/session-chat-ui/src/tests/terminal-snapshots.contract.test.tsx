/** @jsxImportSource solid-js */
import { expect, it } from 'vitest';
import { AcpTranscriptParser, type TerminalState } from '@gugu/session-core/acp';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { segmentCtxFor } from '../state/segment-ctx';
import { executeFromItem } from '../components/rows/tools/execute/execute.presenter';
import { executeUnitDef } from '../components/rows/tools/execute/execute.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

it('shows stored-only output and replaces it by entity identity, including an empty live snapshot', async () => {
  const parser = new AcpTranscriptParser({ sessionId: 'terminal-ui' });
  parser.pushEvent({ kind: 'tool_update', toolCallId: 'cmd', title: 'echo', toolKind: 'execute', status: 'completed',
    contentBlocks: [{ type: 'terminal', terminalId: 't' }] });
  parser.endTurn();
  const terminal: TerminalState = { terminalId: 't', owner: 'agent', canKill: false, command: 'echo', args: [], cwd: '/w',
    output: 'OFFLINE_418', truncated: false, exitStatus: { exitCode: 0, signal: null } };
  parser.pushEvent({ kind: 'terminal_snapshots', terminals: [terminal] });
  const context = createChatContext();
  const state = createChatState(context);
  state.transcript.history.seed(JSON.parse(JSON.stringify(parser.history)));
  const measure = makeContractCtx({ width: 420, isCollapsed: () => true });
  const ctx = segmentCtxFor(context, state, measure.caches, false);
  const item = parser.history[0].items[0];
  if (item.kind !== 'execute-tool-call') throw new Error('Expected command');
  try {
    expect(executeFromItem(item, ctx).outputText).toBe('OFFLINE_418');
    state.session.setTerminals([{ ...terminal, output: 'LIVE_9', exitStatus: null }]);
    const live = executeFromItem(item, ctx);
    expect(live.outputText).toBe('LIVE_9');
    expect(live.exitStatus).toBeUndefined();
    const reading = await renderAndMeasureUnit(executeUnitDef, live, measure, host => {
      expect(host.textContent).not.toContain('OFFLINE_418');
      return { copies: (host.textContent?.match(/LIVE_9/g) ?? []).length };
    });
    expect(reading.inspected.copies).toBe(1);
    state.session.setTerminals([{ ...terminal, output: '', exitStatus: null }]);
    expect(executeFromItem(item, ctx).outputText).toBe('');
  } finally {
    state.dispose(); context.dispose();
  }
});
