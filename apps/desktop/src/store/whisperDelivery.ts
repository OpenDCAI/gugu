/** A queued message remains in the outbox for its existing retry/discard controls. */
export class WhisperDeliveryFailure extends Error {
  constructor(readonly clientMessageId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WhisperDeliveryFailure'
  }
}

export async function waitForWhisperDelivery(outbox: { delivered(id: string): Promise<void> }, id: string): Promise<void> {
  try {
    await outbox.delivered(id)
  } catch (error) {
    throw new WhisperDeliveryFailure(id, error)
  }
}
