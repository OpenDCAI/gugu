import { describe, expect, it } from 'vitest';
import { sessionTabRegistry } from './session-tab-registry';
import { SESSION_TAB_VIEW_KINDS } from './session-tab-views';

// provider 的 TabContent 只是按 kind 取登记内容的薄壳(@@@tab-views),哪种页签没登记，打开它就当场抛。
describe('session tab views', () => {
  it('every session tab kind registers a view, and no view is left without its tab', () => {
    expect([...SESSION_TAB_VIEW_KINDS].sort()).toEqual(sessionTabRegistry.all().map((def) => def.kind).sort());
  });
});
