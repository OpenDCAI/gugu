import { randomUUID } from 'node:crypto';
import { appHumanRequest, APP_HUMAN_CANCEL, APP_HUMAN_COMPLETE, type AppHumanAsk, type AppHumanResult } from '@shared/extensions/app-human';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { ask } from '../asks';

/** Supplied by the host's live invocation, never from the program's arguments or metadata. */
export type ProgramRequestScope = { sessionId: string; signal: AbortSignal };

export async function requestAppHuman(
  manifest: Pick<ExtensionManifest, 'id' | 'name' | 'contributes'>,
  scope: ProgramRequestScope | undefined,
  args: Record<string, unknown>,
): Promise<AppHumanResult> {
  const request = appHumanRequest(args);
  if (!scope) throw Object.assign(new Error('requestHuman needs an active tool call in a session on this machine'), { code: 'unavailable' });
  if (request.tab && !manifest.contributes.tabs.some(tab => tab.name === request.tab)) {
    throw Object.assign(new Error(`This App has no tab named ${request.tab}`), { code: 'invalid' });
  }
  const requestId = randomUUID();
  const result = await ask(scope.sessionId, {
    itemId: requestId, kind: 'permission', title: `${manifest.name}: ${request.title}`,
    ...(request.detail ? { detail: request.detail } : {}),
    options: [
      { optionId: APP_HUMAN_COMPLETE, name: 'Done', kind: 'allow_once' },
      { optionId: APP_HUMAN_CANCEL, name: 'Cancel', kind: 'reject_once' },
    ],
    origin: { source: 'app-human', payload: { ...request, extensionId: manifest.id, appName: manifest.name, sessionId: scope.sessionId } satisfies AppHumanAsk },
  }, { signal: scope.signal, refuse: answer => [APP_HUMAN_COMPLETE, APP_HUMAN_CANCEL].includes(answer.optionId) ? null : 'Choose Done or Cancel for this request' });
  if (result === 'unavailable') throw Object.assign(new Error('The calling session is no longer available on this machine'), { code: 'unavailable' });
  if (result === 'timeout' || result === 'withdrawn') return { requestId, state: result === 'timeout' ? 'timeout' : 'ended' };
  return { requestId, state: result.optionId === APP_HUMAN_COMPLETE ? 'completed' : 'cancelled', by: result.by };
}
