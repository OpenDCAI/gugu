/** Node-only stand-in for browser internal slots and brand-checked getters. */
type EventData = { error?: unknown; filename?: string; lineno?: number; colno?: number; trusted?: boolean }
export class SummaryErrorEvent {
  #data: EventData
  constructor(_type: string, data: EventData = {}) { this.#data = data }
  get isTrusted() { return this.#data.trusted === true }
  get error() { return this.#data.error }
  get filename() { return this.#data.filename ?? '' }
  get lineno() { return this.#data.lineno ?? 0 }
  get colno() { return this.#data.colno ?? 0 }
}
