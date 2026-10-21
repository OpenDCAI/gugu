import { useEffect, useState } from 'react';
import { platform } from '@/platform';
import { desktopIpc } from '@/platform/desktopIpc';
import { DEVICE_ACTIONS_CHANNELS, type DeviceActionsConnectResult, type DeviceActionsState } from '@/lib/deviceActionsIpc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ExtensionManifest } from '@shared/extensions/manifest';

/** The App whose program is gugu's own `computer-use` host: the switch of this computer's computer control (#7317). */
export const switchesComputerControl = (manifest: Pick<ExtensionManifest, 'contributes'>): boolean =>
  (manifest.contributes.mcpServers ?? []).some((server) => 'host' in server && server.host === 'computer-use');

type Managed = NonNullable<DeviceActionsState['managed']>[number];

/**
 * #7317 behavior tab-extensions「Computer Use 是电脑控制的开关」: the one place the system permissions computer control
 * needs are given (❌ a second 「连接」 in Settings). Both are asked at once, as connecting always did (computer-control
 * spec「连上的时候把系统授权一次办好」); macOS answers at once, without asking again, for what is already allowed.
 * Nothing is shown where nothing is needed: off, or a computer that asks for no permission (Windows).
 */
export function ComputerUseAccess() {
  const { translate: t } = useSessionMessages();
  const [state, setState] = useState<{ platform: string; group: Managed | null } | null>(null);
  const [result, setResult] = useState<DeviceActionsConnectResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ipc = desktopIpc();
    if (!ipc) return;
    let disposed = false;
    const load = () => void ipc.invoke(DEVICE_ACTIONS_CHANNELS.state).then((next) => {
      const read = next as DeviceActionsState;
      if (!disposed) setState({ platform: read.platform, group: read.managed?.find((group) => group.id === 'computer') ?? null });
    }, (error: unknown) => {
      if (!disposed) setResult({ ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error) });
    });
    load();
    const off = ipc.eventOn(DEVICE_ACTIONS_CHANNELS.changed, load);
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const group = state?.group ?? null;
  const missing = group?.blocked?.reason === 'unsupported' ? group.blocked.message : null;
  if (!group || !group.connected || (state?.platform !== 'darwin' && !missing)) return null;

  const allow = async () => {
    const ipc = desktopIpc();
    if (!ipc) return;
    setBusy(true);
    try {
      setResult((await ipc.invoke(DEVICE_ACTIONS_CHANNELS.connect, 'computer')) as DeviceActionsConnectResult);
    } catch (error) {
      setResult({ ok: false, code: 'execution_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const said = result
    ? result.ok ? t('appSettings.computerAccess.granted') : result.message
    : missing ?? group.blocked?.message ?? t('appSettings.computerAccess.needs');
  return <section className="tool-app-access" data-testid="computer-use-access">
    <h2>{t('appSettings.computerAccess.title')}</h2>
    <p role={result && !result.ok ? 'alert' : 'status'}>{said}</p>
    {missing || result?.ok ? null : <div className="tool-app-access-actions">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void allow()} data-testid="computer-use-access-allow">
        {t('appSettings.computerAccess.allow')}
      </Button>
      {result && !result.ok && result.restart && platform.capabilities.appRelaunch
        ? <Button size="sm" variant="ghost" onClick={() => void platform.relaunchApp()} data-testid="computer-use-access-restart">
          {t('appSettings.computerAccess.restart')}
        </Button>
        : null}
    </div>}
  </section>;
}
