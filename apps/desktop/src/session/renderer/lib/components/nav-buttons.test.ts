import { beforeEach, describe, expect, it, vi } from 'vitest';

const history = vi.hoisted(() => ({
  back: vi.fn(),
  forward: vi.fn(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    history,
    navigation: {
      _applyNavigation: vi.fn(),
    },
  },
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionView: vi.fn(),
}));

import { navigateBack, navigateForward } from './nav-buttons';

describe('semantic-disabled history actions', () => {
  beforeEach(() => {
    history.back.mockClear();
    history.forward.mockClear();
  });

  it('does not invoke either action while its control is disabled', () => {
    navigateBack(false);
    navigateForward(false);

    expect(history.back).not.toHaveBeenCalled();
    expect(history.forward).not.toHaveBeenCalled();
  });

  it('invokes each action while its control is enabled', () => {
    navigateBack(true);
    navigateForward(true);

    expect(history.back).toHaveBeenCalledOnce();
    expect(history.forward).toHaveBeenCalledOnce();
  });
});
