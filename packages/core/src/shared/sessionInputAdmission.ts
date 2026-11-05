/** The receiving boundary's decision, independent of its diagnostic code or wording. */
export type SessionInputAdmission = 'accepted' | 'rejected' | 'uncertain'

export function sessionInputAdmission(value: unknown): SessionInputAdmission {
  const admission = value && typeof value === 'object' && 'admission' in value ? value.admission : undefined
  return admission === 'accepted' || admission === 'rejected' ? admission : 'uncertain'
}

/** Preserve a host's decision through transports which represent negative replies as exceptions. */
export class SessionInputAdmissionError extends Error {
  readonly admission: SessionInputAdmission
  readonly code?: string
  constructor(message: string, admission: SessionInputAdmission, code?: string) {
    super(message)
    this.admission = admission
    this.code = code
  }
}
