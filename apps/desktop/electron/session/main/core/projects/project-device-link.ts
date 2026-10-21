type ProjectDeviceLink = { project_id?: string; device?: string; target_device: string; path: string; merge_existing?: boolean };
type OnDevice = (device: string | undefined, action: Record<string, unknown>) => Promise<unknown>;

/** Resolve the shared project on its source device, then link the target device's actual folder. */
export async function linkProjectDevice(action: ProjectDeviceLink, onDevice: OnDevice): Promise<Record<string, unknown>> {
  const prepared = await onDevice(action.device, { action: 'project_prepare_device', project_id: action.project_id }) as { project_id: string; name: string; chat_id: string };
  const linked = await onDevice(action.target_device, {
    action: 'project_bind_folder', chat_id: prepared.chat_id, name: prepared.name,
    path: action.path, merge_existing: action.merge_existing,
  }) as Record<string, unknown>;
  return {
    ...linked, project_id: prepared.project_id, name: prepared.name, linked_project_id: linked.project_id, device_id: action.target_device,
    ...(linked.undo && typeof linked.undo === 'object' ? { undo: { ...linked.undo, device_id: action.target_device } } : {}),
    ...(linked.group_notice && typeof linked.group_notice === 'object' ? { group_notice: { ...linked.group_notice, device_id: action.target_device } } : {}),
  };
}
