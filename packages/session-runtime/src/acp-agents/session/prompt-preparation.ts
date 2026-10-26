export type NativePromptPreparation = { text: string; accepted(): Promise<void> }
type Prepare = (sessionId: string) => Promise<NativePromptPreparation>
let prepare: Prepare | null = null

/** Installed by the host in this runtime's module graph. Queue acceptance does
 * not call it; only the final provider request may consume a prepared notice. */
export function setNativePromptPreparation(provider: Prepare | null): void { prepare = provider }
export function prepareNativePrompt(sessionId: string): Promise<NativePromptPreparation> | null {
  return prepare ? prepare(sessionId) : null
}
