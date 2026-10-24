import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AcpPermissionParams } from '../../agents/plugins/capabilities/acp';
import { decodePermissionRequest } from './decode';

const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];

describe('permission transport decoding', () => {
  it('keeps the complete subject and creates a single domain tool projection', () => {
    const tool = { toolCallId: 'read', name: 'Read', kind: 'read', rawInput: { path: '/work/a' },
      locations: [{ path: '/work/a', line: 7 }], _meta: { toolName: 'Agent', vendor: { extra: true } } };
    expect(decodePermissionRequest({ sessionId: 's', toolCall: tool, options })).toEqual({
      sessionId: 's', options, subject: { type: 'tool_call', toolCall: tool },
      toolCall: { kind: 'tool_update', toolCallId: 'read', toolName: 'Read', toolKind: 'read',
        rawInput: JSON.stringify({ path: '/work/a' }, null, 2), locations: [{ path: '/work/a', line: 7 }], _meta: tool._meta },
    });
    expectTypeOf<NonNullable<AcpPermissionParams['toolCall']>['kind']>().toEqualTypeOf<'tool_update'>();
  });

  it.each([null, { type: 'command', command: 'pwd', cwd: '/work', vendor: { retain: true } },
    { type: 'future_subject', content: [{ type: 'future_block', retain: true }] }])(
    'does not revive a legacy tool beside an explicit subject %j', subject => {
      const request = { sessionId: 's', subject, options, description: null, _meta: null };
      expect(decodePermissionRequest({ ...request, toolCall: { toolCallId: 'obsolete' } })).toEqual(request);
    },
  );

  it('preserves missing subject and sparse patches without filling absent fields', () => {
    expect(decodePermissionRequest({ sessionId: 's', options })).toEqual({ sessionId: 's', options });
    expect(decodePermissionRequest({ sessionId: 's', subject: { type: 'tool_call', toolCall: {
      toolCallId: 't', name: null, rawInput: null, content: null, locations: null,
    } }, options }).toolCall).toMatchObject({ kind: 'tool_update', toolCallId: 't', toolName: null,
      rawInput: null, contentBlocks: null, locations: null });
  });

  it('rejects malformed tool locations at ingress', () => {
    expect(() => decodePermissionRequest({ sessionId: 's', options, toolCall: {
      toolCallId: 'bad', locations: [{ path: '' }],
    } })).toThrow('ACP tool location path must not be empty');
  });
});
