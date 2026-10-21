import { makeAutoObservable } from 'mobx';

export type SessionNavFocusLayer = 'nav' | 'composer';

/** The single observable fact consumed by navigation and every session-page auto-focus writer. */
class SessionNavigationFocusStore {
  focusLayer: SessionNavFocusLayer = 'composer';

  constructor() {
    makeAutoObservable(this);
  }
}

export const sessionNavigationFocus = new SessionNavigationFocusStore();
