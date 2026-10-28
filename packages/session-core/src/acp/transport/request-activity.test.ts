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
  const { agent: api, observe } = createRequestActivity(raw as never, event => events.push(event));
  /** A provider event for the session, delivered through the v1 ingress. */
  const provider = (sessionId: string) => observe(sessionId, { kind: 'message' });
  return { api, raw, requests, events, provider, states: () => events.filter(row => row.event.kind === 'agent_state') };
}

describe('v1 request activity boundary', () => {
  it('admits on the provider\'s first event, without claiming native acceptance or waiting for completion', async () => {
    const pair = setup();
    let received = false;
    const receipt = pair.api.prompt({ sessionId: 's', prompt: [] }, {
      requestId: 'r', message: { kind: 'message', role: 'user', messageId: 'local', text: 'visible' },
    }).then(value => { received = true; return value; });
    await Promise.resolve();
    expect(received).toBe(false);
    // The request is active from dispatch; only its admission waits.
    expect(pair.events.map(row => row.event)).toEqual([{ kind: 'agent_state', source: 'request', state: 'running' }]);
    pair.provider('s');
    expect(await receipt).toEqual({ status: 'dispatched', requestId: 'r' });
    expect(pair.events.map(row => row.event)).toEqual([
      { kind: 'agent_state', source: 'request', state: 'running' },
    ]);
    pair.requests[0].resolve({ stopReason: 'end_turn', _meta: { anchor: 1 } });
    await pair.requests[0].promise;
    expect(pair.events.at(-1)?.event).toEqual({ kind: 'agent_state', source: 'request', state: 'idle', stopReason: 'end_turn', _meta: { anchor: 1 } });
  });

  it('admits on a result that arrives before any provider event', async () => {
    const pair = setup();
    const receipt = pair.api.prompt({ sessionId: 's', prompt: [] });
    pair.requests[0].resolve({ stopReason: 'end_turn' });
    expect(await receipt).toMatchObject({ status: 'dispatched' });
    expect(pair.states().map(row => row.event)).toEqual([
      { kind: 'agent_state', source: 'request', state: 'running' },
      { kind: 'agent_state', source: 'request', state: 'idle', stopReason: 'end_turn' },
    ]);
  });

  it('any other failure before output was taken and failed: admitted, with its error on the activity', async () => {
    const pair = setup();
    const receipt = pair.api.prompt({ sessionId: 's', prompt: [] });
    pair.requests[0].reject(Object.assign(new Error('ECONNRESET'), { code: -32000 }));
    await expect(receipt).resolves.toMatchObject({ status: 'dispatched' });
    expect(pair.states().map(row => row.event)).toMatchObject([
      { state: 'running' }, { state: 'idle', stopReason: 'error', error: { message: 'ECONNRESET' } },
    ]);
  });

  it('a request refused for a session the provider no longer owns, before any event, was never admitted', async () => {
    const pair = setup();
    const receipt = pair.api.prompt({ sessionId: 's', prompt: [] });
    const failure = Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } });
    pair.requests[0].reject(failure);
    await expect(receipt).rejects.toBe(failure);
    // No turn boundary: the host unwinds its tentative activity on the rejected receipt.
    expect(pair.events.map(row => row.event)).toEqual([{ kind: 'agent_state', source: 'request', state: 'running' }]);
    // The session is free for the next request.
    const next = pair.api.prompt({ sessionId: 's', prompt: [] });
    pair.provider('s');
    await expect(next).resolves.toMatchObject({ status: 'dispatched' });
    expect(pair.states()).toHaveLength(2);
  });

  it.each([false, true])('concurrent cancellation waits for all requests (reverse=%s)', async reverse => {
    const pair = setup();
    const receipts = [pair.api.prompt({ sessionId: 's', prompt: [] }), pair.api.prompt({ sessionId: 's', prompt: [] })];
    pair.provider('s');
    await Promise.all(receipts);
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
    const receipts = [pair.api.prompt({ sessionId: 's', prompt: [] }), pair.api.prompt({ sessionId: 's', prompt: [] })];
    pair.provider('s');
    await Promise.all(receipts);
    await pair.api.cancel({ sessionId: 's' });
    expect(pair.raw.cancel).toHaveBeenCalledWith({ sessionId: 's' });
    pair.requests[0].resolve({ stopReason: 'cancelled' });
    pair.requests[1].resolve({ stopReason: 'cancelled' });
    await Promise.all(pair.requests.map(r => r.promise));
    expect(pair.states().at(-1)?.event).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
  });

  it('a late primary cancelled result cannot erase a completed concurrent request', async () => {
    const pair = setup();
    const receipts = [pair.api.prompt({ sessionId: 's', prompt: [] }), pair.api.prompt({ sessionId: 's', prompt: [] })];
    pair.provider('s');
    await Promise.all(receipts);
    pair.requests[1].resolve({ stopReason: 'end_turn' });
    await pair.requests[1].promise;
    expect(pair.states()).toHaveLength(1);
    pair.requests[0].resolve({ stopReason: 'cancelled' });
    await pair.requests[0].promise;
    expect(pair.states().at(-1)?.event).toMatchObject({ state: 'idle', stopReason: 'end_turn' });
  });

  it('admitted request failures retain provider error facts and sessions remain independent', async () => {
    const pair = setup();
    const receipts = [pair.api.prompt({ sessionId: 'a', prompt: [] }), pair.api.prompt({ sessionId: 'b', prompt: [] })];
    pair.provider('a');
    pair.provider('b');
    await Promise.all(receipts);
    const observed = pair.requests[0].promise.catch(() => {});
    pair.requests[0].reject(Object.assign(new Error('provider refused'), { code: -32000 }));
    await observed;
    expect(pair.states().at(-1)).toMatchObject({ sessionId: 'a', event: { source: 'request', state: 'idle', stopReason: 'error', error: { message: 'provider refused', code: -32000 } } });
    pair.requests[1].resolve({ stopReason: 'end_turn' });
    await pair.requests[1].promise;
    expect(pair.states().at(-1)?.sessionId).toBe('b');
  });
});
