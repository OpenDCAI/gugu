import type { SessionpageOpenedFileChunk } from '@gugu/session-core/session-record/contract'
import type { WorkspaceFileRef } from '../../session/shared/extensions/app-runtime-protocol'
import { callOnComputer } from './phoneProgramCall'

export type ReadWorkingCopyChunk = (offset: number, length: number) => Promise<SessionpageOpenedFileChunk>

/** A phone's file preview reads the working copy through the same machine call as its folder listing. */
export async function openPhoneWorkingCopyFile(
  app: Parameters<typeof callOnComputer>[0],
  session: Parameters<typeof callOnComputer>[1],
  ref: WorkspaceFileRef,
  show: (path: string, read: ReadWorkingCopyChunk) => void,
): Promise<void> {
  const read: ReadWorkingCopyChunk = async (offset, length) =>
    await callOnComputer(app, session, 'filesRead', { ref, offset, length }) as SessionpageOpenedFileChunk
  // Validate on the owning machine before acknowledging the open. No output-ledger grant is invented for a click.
  await read(0, 1)
  show('id' in ref ? ref.id : ref.name, read)
}
