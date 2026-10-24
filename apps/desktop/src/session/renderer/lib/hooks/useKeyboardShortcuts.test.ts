import { describe, expect, it } from 'vitest';
import { keyboardSettingsSchema } from '@main/core/settings/schema';
import { COMMANDS, getEffectiveHotkey } from './useKeyboardShortcuts';

describe('command bindings', () => {
  it('opens the two modes with O/P, keeps find separate, and releases K and the editor default', () => {
    expect(getEffectiveHotkey('app.quickSwitcher')).toBe('Mod+O');
    expect(getEffectiveHotkey('app.commandPalette')).toBe('Mod+P');
    expect(getEffectiveHotkey('app.find')).toBe('Mod+F');
    expect(getEffectiveHotkey('project.openInEditor')).toBeNull();
    expect(Object.values(COMMANDS).map((command) => command.defaultHotkey)).not.toContain('Mod+K');
  });
  it('accepts only command ids and preserves user remapping and disabled bindings', () => {
    const keyboard = keyboardSettingsSchema.parse({ commandPalette: 'Mod+K', openFile: null, 'app.quickSwitcher': 'Mod+G', 'app.find': null });
    expect(keyboard).toEqual({ 'app.quickSwitcher': 'Mod+G', 'app.find': null });
    expect(getEffectiveHotkey('app.quickSwitcher', keyboard)).toBe('Mod+G');
    expect(getEffectiveHotkey('app.commandPalette', keyboard)).toBe('Mod+P');
    expect(getEffectiveHotkey('app.find', keyboard)).toBeNull();
  });
});
