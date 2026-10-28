import { describe, expect, it, vi } from 'vitest';
import { mutateUserSettingsConfig } from '@gugu/core/cloud/userSettings';
import { rememberAgentCreateDevice } from '@gugu/core/cloud/agentCreateDefaults';
import { fakeSettingsClient } from '../../../support/userSettingsTestDouble';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: state.client }));
const fake = fakeSettingsClient({ 'owner::user': { untouched: { keep: true } } });
state.client = fake.client;
const firstRun = await import('../../../../apps/desktop/src/lib/firstRun');
const { startFirstRunHints } = await import('../../../../apps/desktop/src/lib/firstRunHints');
const { saveProductTourState } = await import('../../../../apps/desktop/src/lib/productTour');
const { writeFileStorage } = await import('../../../../apps/desktop/src/lib/fileStorage');

describe('account settings writers sharing the user row', () => {
  it('preserves an account App choice while the other real setting entry points save concurrently', async () => {
    await Promise.all([
      mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, account_apps: { version: 1, apps: [] } })),
      firstRun.writeOccupation('owner', { key: 'research' }),
      firstRun.writeFirstRunHarness('owner', ['codex']),
      startFirstRunHints('owner'),
      saveProductTourState('owner', { step: 'contacts', status: 'skipped' }),
      writeFileStorage('owner', { retention: '1d' }),
      rememberAgentCreateDevice(fake.client, 'owner', 'device-one'),
    ]);
    expect(fake.rows['owner::user']).toMatchObject({
      untouched: { keep: true }, account_apps: { version: 1, apps: [] }, profile: { occupation: 'research' },
      firstRunHarness: ['codex'], firstRunHints: { version: 1, dismissed: [] },
      productTour: { version: 2, step: 'contacts', status: 'skipped' },
      file_storage: { retention: '1d' }, agent_create: { device_id: 'device-one' },
    });
  });
});
