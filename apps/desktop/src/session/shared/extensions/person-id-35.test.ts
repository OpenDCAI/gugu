import { describe, expect, it } from 'vitest';
import { personId } from './app-runtime-protocol';

/**
 * 摩擦单 F35: one spelling for a person or an agent on both sides — what an App sees (presence, `self`,
 * an entry's `createdBy`) is `user:<uuid>`, as `message_members` and every MCP tool write it.
 */
describe('personId', () => {
  const uuid = '9d377e8d-54e1-4feb-ab98-0ff64ab0771a';
  it('turns a service’s bare uuid into the MCP spelling, and leaves that spelling alone', () => {
    expect(personId(uuid)).toBe(`user:${uuid}`);
    expect(personId(`user:${uuid}`)).toBe(`user:${uuid}`);
    // Control: presence, createdBy and message_members all say the same thing for the same person.
    const presenceId = personId(uuid);
    const createdById = personId(uuid);
    const messageMembersId = `user:${uuid}`;
    expect(new Set([presenceId, createdById, messageMembersId]).size).toBe(1);
  });
});
