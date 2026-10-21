import { describe, expect, it, vi } from 'vitest';

/**
 * E-05 for an agent (`app_install { source_message_id }` → `install_attachment`): the install now answers a refusal
 * (`outcome: 'refused'`) so a card can say it to the person; the agent still gets what it always got — an error with the
 * install's own reason, not a result to read as «not installed, for some reason».
 */

const REASON = '"office" is already installed from somewhere other than a chat attachment; a package from chat cannot replace it';
const installExtensionFromAttachment = vi.hoisted(() => vi.fn());
vi.mock('./extension-attachment-install', () => ({ installExtensionFromAttachment }));
vi.mock('./app-files', () => ({ folderPublisher: async () => ({ id: 'x' }), readAccount: async () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({}) }));

const { runExtensionAgentAction } = await import('./extension-agent-actions');

describe("an agent's install of a chat package over an App that did not come from a chat (E-05)", () => {
  it('rejects with the install’s reason, as it did when the install threw', async () => {
    installExtensionFromAttachment.mockResolvedValueOnce({
      installed: false, outcome: 'refused', id: 'office', name: 'Office', version: '0.1.3', sha256: 's', reason: REASON, from: 'market', installedVersion: '0.1.2',
    });
    await expect(runExtensionAgentAction({ action: 'install_attachment', message_id: 'm-office' })).rejects.toThrow(REASON);
  });

  it('control: an answer that is not a refusal goes back as it is', async () => {
    installExtensionFromAttachment.mockResolvedValueOnce({ installed: false, outcome: 'declined', id: 'office', name: 'Office', version: '0.1.3', sha256: 's' });
    await expect(runExtensionAgentAction({ action: 'install_attachment', message_id: 'm-office' })).resolves.toMatchObject({ outcome: 'declined' });
  });
});
