import { CLOUD_COMPUTER_WAKE_TIMEOUT_MS } from '@gugu/core/cloud/cloudComputer';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  CloudComputerWakeFailed,
  findRemoteHostsBridge,
  onRemoteHostsBridgeChange,
  type RemoteHostsBridge,
} from '@/session/shared/remote-hosts';

/** Explicit mutations need a live host; passive project/session listings never wake it. */
export async function ensureProjectHostReady(projectId: string): Promise<void> {
  const deviceId = machineRegistry.machineOf(projectId);
  if (!deviceId) return;
  const bridge = findRemoteHostsBridge();
  const device = bridge?.listDevices().find(row => row.id === deviceId);
  if (!bridge || !device || (!device.cloudComputer && !device.assistantHome)) return;
  if (!bridge.wakeCloudComputer) throw new CloudComputerWakeFailed('failed', 'unavailable', 'Cloud wake is unavailable');
  const deadline = Date.now() + CLOUD_COMPUTER_WAKE_TIMEOUT_MS;
  await bridge.wakeCloudComputer(deviceId);
  if (findRemoteHostsBridge() !== bridge) throw new CloudComputerWakeFailed('failed', 'signed_out', 'Cloud host connection changed');
  // The shell's React projection may arrive after /state + heartbeat were read.
  // Wait for that same readiness to reach the RPC reachability gate, without
  // retrying (or sending) the mutation while the gate still says asleep.
  await waitForReadyProjection(bridge, deviceId, deadline);
}

function waitForReadyProjection(bridge: RemoteHostsBridge, deviceId: string, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => bridge.listDevices().some(row => row.id === deviceId && row.cloudComputer === 'awake' && row.isOnline);
    if (ready()) { resolve(); return; }
    const timer = setTimeout(() => finish(new CloudComputerWakeFailed('timeout', null, 'Cloud host readiness timed out')), Math.max(0, deadline - Date.now()));
    let offDevices = () => {};
    let offBridge = () => {};
    offDevices = bridge.subscribeDevices(() => { if (ready()) finish(); });
    offBridge = onRemoteHostsBridgeChange(() => {
      if (findRemoteHostsBridge() !== bridge) finish(new CloudComputerWakeFailed('failed', 'signed_out', 'Cloud host connection changed'));
    });
    function finish(error?: Error) {
      clearTimeout(timer);
      offDevices();
      offBridge();
      if (error) reject(error); else resolve();
    }
    if (ready()) finish();
  });
}
