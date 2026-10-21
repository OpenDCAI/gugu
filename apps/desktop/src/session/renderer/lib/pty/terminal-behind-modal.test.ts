// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { terminalIsBehindModal } from './terminal-behind-modal';

/** A session-page terminal as mounted in the workspace (not inside any overlay). */
function mountTerminal(parent: Element = document.body): HTMLElement {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  parent.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('terminalIsBehindModal (#6378)', () => {
  it('a non-modal role=dialog popover (sidebar identity hover card) does not take the keyboard', () => {
    const terminal = mountTerminal();
    const hoverCard = document.createElement('div');
    hoverCard.setAttribute('role', 'dialog');
    hoverCard.setAttribute('data-sidebar-identity-card', '');
    document.body.appendChild(hoverCard);
    expect(terminalIsBehindModal(terminal)).toBe(false);
  });

  it('a base-ui modal hides everything outside it with aria-hidden ⇒ the terminal yields', () => {
    const app = document.createElement('div');
    document.body.appendChild(app);
    const terminal = mountTerminal(app);
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('data-slot', 'dialog-content');
    document.body.appendChild(modal);
    app.setAttribute('aria-hidden', 'true');
    expect(terminalIsBehindModal(terminal)).toBe(true);
  });

  it('an aria-modal dialog outside the terminal takes the keyboard', () => {
    const terminal = mountTerminal();
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(sheet);
    expect(terminalIsBehindModal(terminal)).toBe(true);
  });

  it('the terminal inside the modal (agent sign-in) keeps its keys', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    const terminal = mountTerminal(modal);
    expect(terminalIsBehindModal(terminal)).toBe(false);
  });

  it('no overlay at all ⇒ the terminal owns its keys', () => {
    expect(terminalIsBehindModal(mountTerminal())).toBe(false);
    expect(terminalIsBehindModal(null)).toBe(false);
  });
});
