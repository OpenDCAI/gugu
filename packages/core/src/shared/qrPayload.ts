export type GuguQrPayload = GuguGroupInviteQrPayload | GuguContactQrPayload

export const GUGU_QR_PAYLOAD_QUERY_PARAM = 'gugu_qr'

export type GuguGroupInviteQrPayload = {
  version: 1
  kind: 'group_invite'
  group_public_id: number
  // @@@group-join-token (#653) - the group's unguessable invite secret. Direct join requires it (the
  join_token?: string
}

// @@@contact-qr (#537) - a personal "add me" QR: encodes the owner's 咕咕号 (gugu_number) so a scan/paste
// resolves straight to that user in the add-friend search. Same envelope as the group invite payload.
export type GuguContactQrPayload = {
  version: 1
  kind: 'contact'
  gugu_number: number
}

export type GuguQrScanUrlOptions = {
  downloadUrl: string
}

export function createGroupInviteQrPayload(groupPublicId: number, joinToken?: string): GuguGroupInviteQrPayload {
  if (!isPositiveInteger(groupPublicId)) {
    throw new Error('Group invite QR payload requires a positive integer group_public_id')
  }
  const token = joinToken?.trim()
  return {
    version: 1,
    kind: 'group_invite',
    group_public_id: groupPublicId,
    ...(token ? { join_token: token } : {}),
  }
}

export function createContactQrPayload(guguNumber: number): GuguContactQrPayload {
  if (!isPositiveInteger(guguNumber)) {
    throw new Error('Contact QR payload requires a positive integer gugu_number')
  }
  return {
    version: 1,
    kind: 'contact',
    gugu_number: guguNumber,
  }
}

export function serializeGuguQrPayload(payload: unknown): string {
  const parsed = parseGuguQrPayload(payload)
  if (!parsed) {
    throw new Error('Invalid Gugu QR payload')
  }
  return JSON.stringify(parsed)
}

export function createGuguQrScanUrl(payload: unknown, options: GuguQrScanUrlOptions): string {
  const serializedPayload = serializeGuguQrPayload(payload)
  const url = new URL(options.downloadUrl)
  url.searchParams.set(GUGU_QR_PAYLOAD_QUERY_PARAM, serializedPayload)
  return url.toString()
}

export function parseGuguQrPayload(value: unknown): GuguQrPayload | null {
  const payload = unwrapQrPayload(value)
  if (!payload) return null
  if (payload.version !== 1) return null
  if (payload.kind === 'group_invite') {
    if (!isPositiveInteger(payload.group_public_id)) return null
    const token = typeof payload.join_token === 'string' && payload.join_token.trim() ? payload.join_token.trim() : undefined
    return { version: 1, kind: 'group_invite', group_public_id: payload.group_public_id, ...(token ? { join_token: token } : {}) }
  }
  if (payload.kind === 'contact') {
    if (!isPositiveInteger(payload.gugu_number)) return null
    return { version: 1, kind: 'contact', gugu_number: payload.gugu_number }
  }
  return null
}

function unwrapQrPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const urlPayload = parseQrPayloadFromUrl(value)
    if (urlPayload) return urlPayload
    try {
      const parsed = JSON.parse(value) as unknown
      return unwrapQrPayload(parsed)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.payload && typeof record.payload === 'object') {
    return record.payload as Record<string, unknown>
  }
  return record
}

function parseQrPayloadFromUrl(value: string): Record<string, unknown> | null {
  try {
    const url = new URL(value)
    const payload = url.searchParams.get(GUGU_QR_PAYLOAD_QUERY_PARAM)
    if (!payload) return null
    return unwrapQrPayload(JSON.parse(payload) as unknown)
  } catch {
    return null
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
