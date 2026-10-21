import { describe, expect, it } from 'vitest';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import { userAvailableWidth } from './metrics';

const DOUBLE: ChatLayout = { preset: 'double', userGutter: 72 };

describe('userAvailableWidth', () => {
  it('reserves the whole gutter in a normal column', () => {
    expect(userAvailableWidth(640, DOUBLE)).toBe(568);
  });

  it('keeps ≥3/4 of a narrow column for the pill (#7052: a session squeezed into one of several blocks)', () => {
    expect(userAvailableWidth(128, DOUBLE)).toBe(96);
  });

  it('reserves nothing outside the double-column layout', () => {
    expect(userAvailableWidth(128, { preset: 'single', userGutter: 0 })).toBe(128);
  });
});
