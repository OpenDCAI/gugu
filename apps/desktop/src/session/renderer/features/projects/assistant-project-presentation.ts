import { observable, runInAction } from 'mobx';
import { machineRegistry } from '@renderer/lib/machine-routing';

// Host identity comes from the account's device directory, including for hosts
// predating the assistant-project migration. This changes presentation only:
// original project/session ids, history, folders and routing remain intact.
const assistantHomes = observable.set<string>();

export function setAssistantProjectHosts(devices: readonly { id: string; assistantHome?: true }[]): void {
  runInAction(() => assistantHomes.replace(devices.filter(device => device.assistantHome).map(device => device.id)));
}

export function isAssistantHostProject(project: { id: string }): boolean {
  const machine = machineRegistry.machineOf(project.id);
  return machine !== null && assistantHomes.has(machine);
}
