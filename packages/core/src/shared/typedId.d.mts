export type TypedIdKind = 'session' | 'project' | 'msg' | 'agent' | 'user' | 'chat' | 'gugu' | 'extension' | 'device' | 'schedule' | 'post' | 'reply'
export type IdentityAddress = { kind: 'user'; id: string } | { kind: 'gugu'; number: number }
export const TYPED_ID_KINDS: readonly TypedIdKind[]
export function encodeTypedId(kind: TypedIdKind, raw: string): string
export function decodeTypedId(kind: TypedIdKind, value: unknown, field: string): string
export function readTypedIdLenient(kind: TypedIdKind, value: unknown): string | null
export function decodeIdentityAddress(value: unknown, field: string): IdentityAddress
