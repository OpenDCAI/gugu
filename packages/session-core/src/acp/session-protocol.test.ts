import { describe, expectTypeOf, it } from 'vitest';
import type { ReducerInput } from './reducer/reducer';
import type {
  SessionEntityUpsert,
  SessionForegroundState,
  SessionMessageUpsert,
  SessionPatch,
  SessionPromptReceipt,
  SessionProtocolPort,
  SessionTerminalUpdate,
} from './session-protocol';

describe('session domain contracts', () => {
  it('does not admit raw protocol updates to the domain reducer', () => {
    expectTypeOf<Extract<ReducerInput, { kind: 'update' }>>().toBeNever();
  });
  it('keeps dispatch and agent acceptance distinct from foreground completion', () => {
    type Dispatched = Extract<SessionPromptReceipt, { status: 'dispatched' }>;
    type Accepted = Extract<SessionPromptReceipt, { status: 'accepted' }>;
    expectTypeOf<Dispatched>().not.toHaveProperty('messageId');
    expectTypeOf<Accepted>().toHaveProperty('messageId').toEqualTypeOf<string>();
    expectTypeOf<SessionPromptReceipt>().not.toHaveProperty('stopReason');
    expectTypeOf<SessionProtocolPort<SessionForegroundState>['prompt']>()
      .returns.resolves.toEqualTypeOf<SessionPromptReceipt>();
  });

  it('preserves unknown activity and an idle with no reported reason', () => {
    expectTypeOf<{ source: 'agent'; state: 'unknown' }>().toExtend<SessionForegroundState>();
    expectTypeOf<{ source: 'request'; state: 'idle' }>().toExtend<SessionForegroundState>();
    expectTypeOf<{ source: 'agent'; state: 'idle'; stopReason: null }>().toExtend<SessionForegroundState>();
  });

  it('allows replacement, clearing and omission without append-only fields', () => {
    type Message = SessionMessageUpsert<{ type: 'text'; text: string }>;
    expectTypeOf<{ messageId: string }>().toExtend<Message>();
    expectTypeOf<{ messageId: string; content: null }>().toExtend<Message>();
    expectTypeOf<{ messageId: string; content: [] }>().toExtend<Message>();
    expectTypeOf<SessionEntityUpsert<{ title: string }>['title']>()
      .toEqualTypeOf<string | null | undefined>();
  });

  it('keeps structured file changes without requiring patch text or a baseline', () => {
    expectTypeOf<{
      changes: [{ operation: 'move'; oldPath: string; newPath: string }];
      scope: 'unknown';
    }>().toExtend<SessionPatch>();
  });

  it('keeps a display terminal independent of a tool and a process handle', () => {
    expectTypeOf<{ terminalId: string; exitStatus: Record<string, never> }>()
      .toExtend<SessionTerminalUpdate>();
    expectTypeOf<SessionTerminalUpdate>().not.toHaveProperty('toolCallId');
    expectTypeOf<SessionTerminalUpdate>().not.toHaveProperty('pid');
  });
});
