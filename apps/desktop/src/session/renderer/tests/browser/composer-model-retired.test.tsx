import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { root?.unmount(); container?.remove(); root = null; container = null; });

it('shows retirement inside the model setting and lets the user choose a replacement in place', async () => {
  await page.viewport(1000, 800);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const changed = vi.fn();
  const refresh = vi.fn();
  root.render(<SessionLocalizationProvider><ChatComposer
    selectedModel="platform:retired-model"
    modelOptions={{
      'platform:retired-model': { name: 'Retired model', disabled: true, disabledReason: 'This model has been retired' },
      'platform:available-model': { name: 'Available model' },
    }}
    modelSettingNotice="This model has been retired"
    onModelMenuOpen={refresh}
    onModelChange={changed}
    onSubmit={() => {}}
    onStop={() => {}}
  /></SessionLocalizationProvider>);
  await until('recovery is visible in the model control', () => document.querySelector('[data-testid="composer-model-trigger"]')?.textContent?.includes('This model has been retired') === true);
  await page.getByTestId('composer-model-trigger').click();
  await until('setting explains the problem', () => document.querySelector('[data-testid="composer-model-setting-notice"]')?.textContent === 'This model has been retired');
  expect(refresh).toHaveBeenCalledOnce();
  const old = page.getByRole('option', { name: /Retired model/ });
  await expect.element(old).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: /Available model/ }).click();
  expect(changed).toHaveBeenCalledExactlyOnceWith('platform:available-model');
});
