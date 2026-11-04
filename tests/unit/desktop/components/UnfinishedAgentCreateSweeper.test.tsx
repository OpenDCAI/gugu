// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNode, createReactHarness } from '../../../support/testHarness';
import type { UnfinishedSingleAgentOutcome } from '../../../../apps/desktop/src/lib/unfinishedSingleAgentSweep';

const h = vi.hoisted(() => ({ outcomes: [] as UnfinishedSingleAgentOutcome[], toast: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock('../../../../apps/desktop/src/lib/unfinishedSingleAgentSweep', () => ({ sweepUnfinishedSingleAgents: async () => h.outcomes }));
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ refreshChats: h.refresh }) }));
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: h.toast }) }));
import { UnfinishedAgentCreateSweeper } from '../../../../apps/desktop/src/components/UnfinishedAgentCreateSweeper';

let ui: ReturnType<typeof createReactHarness>;
afterEach(() => { ui.cleanup(); vi.clearAllMocks(); });
async function render(outcomes: UnfinishedSingleAgentOutcome[]) {
  h.outcomes = outcomes;
  ui = createReactHarness();
  await ui.render(createNode(UnfinishedAgentCreateSweeper));
}

describe('unfinished creation only interrupts for unresolved cleanup', () => {
  it('refreshes a completed creation without a success toast', async () => {
    await render([{ operationId: 'ok', kind: 'completed', session: {} as Extract<UnfinishedSingleAgentOutcome, { kind: 'completed' }>['session'] }]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled();
  });
  it('keeps discarded and cleanly cancelled work quiet', async () => {
    await render([{ operationId: 'discard', kind: 'discarded' }, { operationId: 'cancel', kind: 'cancelled', warningStages: [] }]);
    expect(h.toast).not.toHaveBeenCalled();
  });
  it('keeps the pending/error and cancellation warning notices', async () => {
    await render([{ operationId: 'pending', kind: 'pending', stages: ['stop'] }, { operationId: 'error', kind: 'pending', stages: [] },
      { operationId: 'warning', kind: 'cancelled', warningStages: ['stop'] }]);
    expect(h.toast.mock.calls.map((call) => call[1])).toEqual(['error', 'error', 'warning']);
  });
});
