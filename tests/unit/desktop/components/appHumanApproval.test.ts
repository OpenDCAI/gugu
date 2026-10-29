import { describe, expect, it } from 'vitest';
import { appHumanAskOf, appHumanRequest } from '../../../../apps/desktop/src/session/shared/extensions/app-human';
import { appHumanTarget, appHumanWords } from '../../../../apps/desktop/src/session/renderer/features/extensions/app-human-approval';
import { translateSessionMessage } from '../../../../apps/desktop/src/session/renderer/localization/locale-store';

describe('the shared App human step', () => {
  const ask = { title: 'Finish this step', extensionId: 'notes', appName: 'Notes', tab: 'main', sessionId: 'session-a' };
  it('navigation retains the exact App, tab and calling session', () => {
    expect(appHumanAskOf({ source: 'app-human', payload: ask })).toEqual(ask);
    expect(appHumanTarget(ask)).toEqual({ kind: 'app', extensionId: 'notes', tab: 'main', path: '', query: {}, place: { session: 'session-a' } });
    expect(appHumanTarget({ ...ask, tab: undefined })).toBeNull();
    expect(appHumanWords(ask, translateSessionMessage).label('open-app')).toBeTruthy();
    expect(appHumanWords(ask, translateSessionMessage).label('complete')).toBeTruthy();
  });
  it('rejects invalid payloads and unrelated or ambiguous request fields', () => {
    expect(appHumanAskOf({ source: 'app-install', payload: ask })).toBeNull();
    expect(appHumanAskOf({ source: 'app-human', payload: {} })).toBeNull();
    expect(() => appHumanRequest({ title: 'ok', tab: '../other' })).toThrow();
    expect(() => appHumanRequest({ title: 'ok', detail: 123 })).toThrow();
  });
});
