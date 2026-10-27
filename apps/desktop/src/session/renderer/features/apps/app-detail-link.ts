import type { AppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { cachedDevicesAccount, readCachedDevices } from '@/store/devicesCache';
import { readMobileShell } from '@/hooks/useMobileShell';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { rpcOn } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { libraryDeviceStore, LOCAL_DEVICE_SCOPE } from '@renderer/features/remote-hosts/device-scope-store';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** Validate the named host before selecting a scope: the picker otherwise falls back to local. */
export async function openAppDetailLink(target: AppDetailLink, ownerId: string, isCurrent = () => true) {
  if (readMobileShell()) throw new Error(translateSessionMessage('extensions.appLinkOnPhone'));
  let scope = LOCAL_DEVICE_SCOPE;
  if (target.deviceId) {
    const device = cachedDevicesAccount() === ownerId ? readCachedDevices().find((row) => row.device_id === target.deviceId) : undefined;
    if (!device) throw new Error(`Device ${target.deviceId} is not registered to your account.`);
    if (!device.is_current_device) {
      if (!remoteHostsStore.device(target.deviceId)) throw new Error(`Device ${target.deviceId} is unavailable; open Devices and reconnect it.`);
      scope = target.deviceId;
    }
    const result = await rpcOn(scope === LOCAL_DEVICE_SCOPE ? null : scope).extensions.variants(target.extensionId);
    if (!result.success || !result.data) throw new Error(result.error ?? 'The installed App is unavailable on that device.');
    if (target.variant && !result.data.variants.some((row) => row.name === target.variant)) throw new Error(`Variant ${target.variant} is no longer installed on that device.`);
  }
  if (!isCurrent()) return;
  libraryDeviceStore.select(scope);
  revealSessionpage();
  appState.navigation.navigate('apps', { detail: target });
}
