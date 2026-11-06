import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialCleanup, type CredentialArtifactCleanup } from './credential-cleanup';
import { CREDENTIAL_ARTIFACT_KINDS, CredentialOutputDrain, credentialArtifactCleanup } from './credential-cleanup-artifacts';
import type { CredentialUseBinding } from './credential-use-contract';

const binding = Object.freeze({ useId: randomUUID() }) as CredentialUseBinding;

describe('credential cleanup evidence', () => {
  it('scrubbing for a person never produces a full proof and never destroys the page', async () => {
    const destroy = vi.fn(async () => ({ status: 'destroyed' as const }));
    const cleanup = new CredentialCleanup(binding, { destroy,
      clearFilledFields: async () => ({ status: 'cleared' }) },
    { quiesce: async () => true, clear: async () => true, verify: async () => true });
    expect(await cleanup.run(false)).toEqual({ status: 'isolated_login_retained' });
    expect(cleanup.failed).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(await cleanup.run(true, 'document-2')).toEqual({ status: 'cleaned' });
    expect(destroy).toHaveBeenCalledWith(binding, 'document-2');
  });

  it('drains a real late file writer before deletion and verifies the actual directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'credential-cleanup-test-'));
    const drain = new CredentialOutputDrain(), file = join(directory, 'synthetic-artifact');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const marker = randomUUID();
    try {
      // This deliberate pre-existing artifact tests cleanup, never the no-capture release criterion.
      await writeFile(file, marker);
      const positiveControl = (await readFile(file, 'utf8')) === marker;
      expect(positiveControl).toBe(true);
      const writer = drain.run(async () => { await gate; await writeFile(file, marker); });
      const cleared = vi.fn(async () => { for (const name of await readdir(directory)) await rm(join(directory, name)); return true; });
      const cleanup = new CredentialCleanup(binding, { clearFilledFields: async () => ({ status: 'cleared' }),
        destroy: async () => ({ status: 'destroyed' }) },
      { quiesce: () => drain.sealAndDrain(), clear: cleared, verify: async () => (await readdir(directory)).length === 0 });
      const pending = cleanup.run(true);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(cleared).not.toHaveBeenCalled();
      release(); await writer;
      expect(await pending).toEqual({ status: 'cleaned' });
      expect(await readdir(directory)).toEqual([]);
      await expect(drain.run(async () => { await writeFile(file, marker); })).rejects.toThrow('credential_output_closed');
      expect(await readdir(directory)).toEqual([]);
    } finally { release(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not certify writer failure, even after all observed callbacks have settled', async () => {
    const drain = new CredentialOutputDrain();
    await expect(drain.run(async () => { throw new Error(randomUUID()); })).rejects.toThrow('credential_output_failed');
    expect(await drain.sealAndDrain()).toBe(false);
  });

  it('keeps clearing other output classes when one custodian throws or is missing', async () => {
    const create = () => ({ quiesce: vi.fn(async () => true), clear: vi.fn(async () => true), verify: vi.fn(async () => true) });
    const custodians = Object.fromEntries(CREDENTIAL_ARTIFACT_KINDS.map(kind => [kind, create()])) as Record<typeof CREDENTIAL_ARTIFACT_KINDS[number], ReturnType<typeof create>>;
    custodians.console.clear.mockRejectedValueOnce(new Error(randomUUID()));
    const all = credentialArtifactCleanup(custodians);
    expect(await all.clear(binding)).toBe(false);
    expect(custodians.errors.clear).toHaveBeenCalledOnce();
    const { crash: _missing, ...incomplete } = custodians;
    const partial = credentialArtifactCleanup(incomplete as unknown as Record<typeof CREDENTIAL_ARTIFACT_KINDS[number], CredentialArtifactCleanup>);
    expect(await partial.verify(binding)).toBe(false);
    expect(custodians.errors.verify).toHaveBeenCalledOnce();
  });

  it('latches document-fence destruction failure and cannot be repaired into handoff eligibility', async () => {
    const destroy = vi.fn(async () => ({ status: 'isolated_login_retained' as const }));
    const cleanup = new CredentialCleanup(binding, { destroy, clearFilledFields: async () => ({ status: 'cleared' }) },
      { quiesce: async () => true, clear: async () => true, verify: async () => true });
    expect(await cleanup.run(true, 'stale-document')).toEqual({ status: 'isolated_login_retained' });
    expect(cleanup.failed).toBe(true);
    await cleanup.run(true, 'new-document');
    expect(cleanup.confirmed).toBe(false);
  });
});
