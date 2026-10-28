import { expect, it } from 'vitest';
import { appContextMenuOf } from './app-context-menu';

it('passes only shared menu presentation and action ids across the App boundary', () => {
  expect(appContextMenuOf({ x: 10, y: 20, items: [{ id: 'show', label: 'Show App data', enabled: false, click: 'untrusted' }, { type: 'separator' }] }))
    .toEqual({ x: 10, y: 20, items: [{ id: 'show', label: 'Show App data', enabled: false }, { type: 'separator' }] });
});
it('rejects ambiguous actions and malformed menu coordinates', () => {
  expect(() => appContextMenuOf({ x: NaN, y: 0, items: [] })).toThrow(/finite/);
  expect(() => appContextMenuOf({ x: 1, y: 2, items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toThrow(/unique/);
});
