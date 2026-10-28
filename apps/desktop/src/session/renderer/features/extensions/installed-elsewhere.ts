import { findRemoteHostsBridge, type RemoteHostDevice } from '@shared/remote-hosts';
import { rpc, rpcOn } from '@renderer/lib/ipc';

export interface InstalledElsewhereDependencies {
  /** The person's other computers, as this window knows them. */
  devices: () => readonly Pick<RemoteHostDevice, 'id' | 'isOnline'>[];
  /** The Apps installed on one computer (null: this one). */
  installed: (deviceId: string | null) => Promise<readonly string[]>;
}

const defaults: InstalledElsewhereDependencies = {
  devices: () => findRemoteHostsBridge()?.listDevices() ?? [],
  installed: async (deviceId) => {
    const result = await (deviceId ? rpcOn(deviceId) : rpc).extensions.list();
    if (!result.success || !result.data) throw new Error(result.error ?? 'unreadable');
    return result.data.extensions.map((manifest) => manifest.id);
  },
};

/**
 * I10 Whether an App uninstalled from `from` (null: this computer) stays on another of the person's computers — or may: an
 * offline one, or one whose list cannot be read, counts as having it, so its grants in chats are only cleared when no
 * computer can still be giving it.
 */
export async function installedElsewhere(extensionId: string, from: string | null, dependencies = defaults): Promise<boolean> {
  const others = [...(from ? [null] : []), ...dependencies.devices().filter((device) => device.id !== from)];
  if (others.some((device) => device !== null && !device.isOnline)) return true;
  const answers = await Promise.all(others.map((device) =>
    dependencies.installed(device?.id ?? null).then((ids) => ids.includes(extensionId), () => true)));
  return answers.some(Boolean);
}
