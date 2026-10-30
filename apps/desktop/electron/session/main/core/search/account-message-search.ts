import { app } from 'electron';
import { userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { appSettingsService } from '@main/core/settings/settings-service';
import { AccountMessageSearch } from './message-store';

// Reuse the host's installed account reader. Never read disk credentials or ask the renderer again.
export const accountMessageSearch = new AccountMessageSearch(() => app.getPath('userData'), async () => {
  const token = await currentAccountAccessToken();
  if (token === null) return null;
  const id = userIdFromSupabaseAccessToken(token);
  if (!id) throw new Error('Search host access token has no account');
  return id;
}, async () => (await appSettingsService.get('globalSearch')).v3);

export const messageSearchAccountChanged = (accountId: string | null): void => accountMessageSearch.accountChanged(accountId);
