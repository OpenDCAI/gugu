import type { AskOrigin } from '@gugu/session-core/session-record/contract';

export const APP_HUMAN_COMPLETE = 'complete';
export const APP_HUMAN_CANCEL = 'cancel';
export const APP_HUMAN_OPEN = 'open-app';
export const APP_HUMAN_TIMEOUT_MS = 10 * 60_000;

export type AppHumanRequest = { title: string; detail?: string; tab?: string };
export type AppHumanAsk = AppHumanRequest & { extensionId: string; appName: string; sessionId: string };
export type AppHumanResult = {
  requestId: string;
} & ({ state: 'completed' | 'cancelled'; by: string } | { state: 'timeout' | 'ended' });

/** The program names only its own task step. App identity and session come from its host call. */
export function appHumanRequest(args: Record<string, unknown>): AppHumanRequest {
  const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });
  if (Object.keys(args).some(key => !['title', 'detail', 'tab'].includes(key))) throw invalid('requestHuman takes only title, detail and tab');
  if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 500) throw invalid('requestHuman needs a title of 1–500 characters');
  if (args.detail !== undefined && (typeof args.detail !== 'string' || args.detail.length > 8_000)) throw invalid('requestHuman detail must be text of at most 8000 characters');
  if (args.tab !== undefined && (typeof args.tab !== 'string' || !/^[a-z][a-z0-9-]*$/.test(args.tab))) throw invalid('requestHuman tab must name one of this App’s tabs');
  return { title: args.title.trim(), ...(args.detail === undefined ? {} : { detail: args.detail as string }),
    ...(args.tab === undefined ? {} : { tab: args.tab as string }) };
}

export function appHumanAskOf(origin: AskOrigin | undefined): AppHumanAsk | null {
  if (origin?.source !== 'app-human' || !origin.payload || typeof origin.payload !== 'object') return null;
  const value = origin.payload as AppHumanAsk;
  return typeof value.extensionId === 'string' && typeof value.appName === 'string' && typeof value.title === 'string' && typeof value.sessionId === 'string'
    && (value.tab === undefined || typeof value.tab === 'string') ? value : null;
}
