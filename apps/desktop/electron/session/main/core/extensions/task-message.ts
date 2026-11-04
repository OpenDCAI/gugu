import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import { taskMessageIntent, taskMessageText } from '@shared/extensions/task-message';
import type { BridgeCaller } from './extension-bridge';

/** A person's click in this task's App page sends a host-owned ordinary message, never Stop. */
export async function sendTaskMessage(caller: BridgeCaller, args: Record<string, unknown>, locale: string,
  deliver: (page: NonNullable<BridgeCaller['binding']>, text: string) => Promise<unknown>): Promise<void> {
  if (caller.kind !== 'page' || caller.gesture !== true || !caller.binding
    || caller.binding.operator.kind !== 'person' || !workspaceSession(caller.binding)) {
    throw Object.assign(new Error('A task message needs a person’s click in a bound task page'), { code: 'denied' });
  }
  const intent = taskMessageIntent(args);
  // Capture before the first await: rebinding a page cannot redirect this click to another task.
  const page = { ...caller.binding };
  await deliver(page, taskMessageText(intent, locale));
}
