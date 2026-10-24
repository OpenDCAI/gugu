import { describe, expect, it, vi } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import { createRequestActivity } from './request-activity';
import type { NormalizedEvent } from '../reducer/normalized-event';

function setup() {
  const requests: ReturnType<typeof Promise.withResolvers<PromptResponse>>[] = [];
  const events: { sessionId: string; event: NormalizedEvent }[] = [];
  const raw = { prompt: vi.fn(() => {
    const request = Promise.withResolvers<PromptResponse>();
    requests.push(request);
    return request.promise;
  }), cancel: vi.fn(async () => {}) };
  const { agent: api } = createRequestActivity(raw as never, event => events.push(event));
  return { api, raw, requests, events, states: () => events.filter(row => row.event.kind === 'agent_state') };
}

describe('v1 request activity boundary', () => {
  it('returns dispatch without claiming acceptance or waiting for completion', async () => {
    const pair = setup();
    const receipt = await pair.api.prompt({ sessionId: 's', prompt: [] }, {
      requestId: 'r', message: { kind: 'message', role: 'user', messageId: 'local', text: 'visible' },
    });
    expect(receipt).toEqual({ status: 'dispatched', requestId: 'r' });
    expect(pair.events.map(row => row.event)).toEqual([
      { kind: 'agent_state', source: 'request', state: 'running' },
    ]);
    pair.requests[0].resolve({ stopReason: 'end_turn', _meta: { anchor: 1 } });
    await pair.requests[0].promise;
    expect(pair.events.at(-1)?.event).toEqual({ kind: 'agent_state', source: 'request', state: 'idle', stopReason: 'end_turn', _meta: { anchor: 1 } });
  });

  it.each([false, true])('concurrent cancellation waits for all requests (reverse=%s)', async reverse => {
    const pair = setup();
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    const first = reverse ? 1 : 0;
    pair.requests[first].resolve({ stopReason: 'cancelled' });
    await pair.requests[first].promise;
    expect(pair.states()).toHaveLength(1);
    pair.requests[1 - first].resolve({ stopReason: 'end_turn' });
    await pair.requests[1 - first].promise;
    expect(pair.states().map(row => row.event)).toEqual([
      { kind: 'agent_state', source: 'request', state: 'running' },
      { kind: 'agent_state', source: 'request', state: 'idle', stopReason: 'end_turn' },
    ]);
  });

  it('a real cancellation waits for every cancelled request and remains cancelled', async () => {
    const pair = setup();
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    await pair.api.cancel({ sessionId: 's' });
    expect(pair.raw.cancel).toHaveBeenCalledWith({ sessionId: 's' });
    pair.requests[0].resolve({ stopReason: 'cancelled' });
    pair.requests[1].resolve({ stopReason: 'cancelled' });
    await Promise.all(pair.requests.map(r => r.promise));
    expect(pair.states().at(-1)?.event).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
  });

  it('a late primary cancelled result cannot erase a completed concurrent request', async () => {
    const pair = setup();
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    await pair.api.prompt({ sessionId: 's', prompt: [] });
    pair.requests[1].resolve({ stopReason: 'end_turn' });
    await pair.requests[1].promise;
    expect(pair.states()).toHaveLength(1);
    pair.requests[0].resolve({ stopReason: 'cancelled' });
    await pair.requests[0].promise;
    expect(pair.states().at(-1)?.event).toMatchObject({ state: 'idle', stopReason: 'end_turn' });
  });

  it('request failures retain provider error facts and sessions remain independent', async () => {
    const pair = setup();
    await pair.api.prompt({ sessionId: 'a', prompt: [] });
    await pair.api.prompt({ sessionId: 'b', prompt: [] });
    const observed = pair.requests[0].promise.catch(() => {});
    pair.requests[0].reject(Object.assign(new Error('provider refused'), { code: -32000 }));
    await observed;
    expect(pair.states().at(-1)).toMatchObject({ sessionId: 'a', event: { source: 'request', state: 'idle', stopReason: 'error', error: { message: 'provider refused', code: -32000 } } });
    pair.requests[1].resolve({ stopReason: 'end_turn' });
    await pair.requests[1].promise;
    expect(pair.states().at(-1)?.sessionId).toBe('b');
  });
});
