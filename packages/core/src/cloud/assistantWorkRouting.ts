export type AssistantWorkAddress = { session_id: string; device_id: string }

function address(value: AssistantWorkAddress | null): AssistantWorkAddress | null {
  if (value === null) return null
  if (!value || typeof value.session_id !== 'string' || !value.session_id
    || typeof value.device_id !== 'string' || !value.device_id) {
    throw Object.assign(new Error('Invalid work route'), { code: 'INVALID_WORK_ROUTE' })
  }
  return value
}

/** The event's original address is part of its immutable identity. A null
 * projection means the new home has not bound a real Gugu session yet. */
export function assistantWorkDeliveryTarget(event: {
  kind: string; to_session_id: string; to_device_id: string; delivery_target?: AssistantWorkAddress | null
}): AssistantWorkAddress | null {
  return address(event.kind === 'dispatch' || event.delivery_target === undefined
    ? { session_id: event.to_session_id, device_id: event.to_device_id }
    : event.delivery_target)
}

export function assistantWorkCoordinator(work: {
  coordinator_session_id: string; coordinator_device_id: string; coordinator_current?: AssistantWorkAddress | null
}): AssistantWorkAddress | null {
  return address(work.coordinator_current === undefined
    ? { session_id: work.coordinator_session_id, device_id: work.coordinator_device_id }
    : work.coordinator_current)
}
