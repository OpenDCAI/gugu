import { useHotkeyRecorder, type Hotkey } from '@tanstack/react-hotkeys';
import { RotateCcw, X } from '@/lib/icons'
import React, { useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { toast } from '@renderer/lib/hooks/use-toast';
import {
  APP_SHORTCUTS,
  getEffectiveHotkey,
  resolveDefaultHotkey,
  sharesChordIntentionally,
  type ShortcutSettingsKey,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { Button } from '@renderer/lib/ui/button';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { describeHotkey } from '@renderer/lib/ui/shortcut-format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const CONFIGURABLE_SHORTCUTS = (
  Object.entries(APP_SHORTCUTS) as [
    ShortcutSettingsKey,
    (typeof APP_SHORTCUTS)[ShortcutSettingsKey],
  ][]
).filter(([, def]) => !def.hideFromSettings);

const SHORTCUTS_BY_CATEGORY = CONFIGURABLE_SHORTCUTS.reduce<
  Record<string, [ShortcutSettingsKey, (typeof APP_SHORTCUTS)[ShortcutSettingsKey]][]>
>((acc, entry) => {
  const category = entry[1].category;
  if (!acc[category]) acc[category] = [];
  acc[category].push(entry);
  return acc;
}, {});

const KeyboardSettingsCard: React.FC = () => {
  const {
    value: keyboard,
    update,
    isLoading: loading,
    isSaving: saving,
    resetField,
  } = useAppSettingsKey('keyboard');
  const { translate } = useSessionMessages();

  const [editingKey, setEditingKey] = useState<ShortcutSettingsKey | null>(null);

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey: Hotkey) => {
      if (!editingKey) return;

      const conflict = CONFIGURABLE_SHORTCUTS.find(([key]) => {
        if (key === editingKey) return false;
        // A registered intentional share is not a conflict — refusing it here would make the
        // shared default unreachable once the user has rebound either half.
        if (sharesChordIntentionally(key, editingKey)) return false;
        return getEffectiveHotkey(key, keyboard) === hotkey;
      });

      if (conflict) {
        const [, def] = conflict;
        const msg = translate('keyboard.conflictDescription', { label: def.label });
        toast({
          title: translate('keyboard.conflictTitle'),
          description: msg,
          variant: 'destructive',
        });
        recorder.cancelRecording();
        setEditingKey(null);
        return;
      }

      update({ [editingKey]: hotkey });
      toast({
        title: translate('keyboard.updatedTitle'),
        description: translate('keyboard.updatedDescription', {
          label: APP_SHORTCUTS[editingKey].label,
          hotkey: describeHotkey(hotkey),
        }),
      });
      setEditingKey(null);
    },
    onCancel: () => setEditingKey(null),
  });

  const startCapture = (key: ShortcutSettingsKey) => {
    setEditingKey(key);
    recorder.startRecording();
  };

  const handleReset = (key: ShortcutSettingsKey) => {
    resetField(key);
    toast({
      title: translate('keyboard.resetTitle'),
      description: translate('keyboard.resetDescription', { label: APP_SHORTCUTS[key].label }),
    });
  };

  const handleClear = (key: ShortcutSettingsKey) => {
    update({ [key]: null });
    toast({
      title: translate('keyboard.removedTitle'),
      description: translate('keyboard.removedDescription', { label: APP_SHORTCUTS[key].label }),
    });
  };

  return (
    <div className="bg-background-2/10 rounded-lg p-4">
      <div className="space-y-6">
        {Object.entries(SHORTCUTS_BY_CATEGORY).map(([category, shortcuts]) => (
          <div key={category}>
            <div className="text-foreground-muted mb-3 text-xs font-medium tracking-wide uppercase">
              {category}
            </div>
            <div className="space-y-3">
              {shortcuts.map(([key, def]) => {
                const effectiveHotkey = getEffectiveHotkey(key, keyboard);
                const capturing = editingKey === key && recorder.isRecording;
                const cleared = keyboard?.[key] === null;
                const showClear = !cleared;
                const defaultHotkey = resolveDefaultHotkey(def);
                const showReset = defaultHotkey != null && effectiveHotkey !== defaultHotkey;
                const showActions = showClear || showReset;

                return (
                  <div
                    key={key}
                    className="group/shortcut flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-2"
                  >
                    <div className="min-w-0 flex-1 basis-64 space-y-1">
                      <div className="text-sm break-words">{def.label}</div>
                      <div className="text-foreground-muted text-xs break-words">
                        {def.description}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {capturing ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-w-[80px] animate-pulse"
                            onClick={() => recorder.cancelRecording()}
                            disabled={saving}
                          >
                            {translate('keyboard.pressKeys')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => recorder.cancelRecording()}
                            disabled={saving}
                          >
                            {translate('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {showActions && (
                            <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover/shortcut:pointer-events-auto group-hover/shortcut:opacity-100">
                              <TooltipProvider delay={150}>
                                {showReset && (
                                  <Tooltip>
                                    <TooltipTrigger render={<span className="inline-flex" />}>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-foreground-muted hover:text-foreground"
                                        onClick={() => handleReset(key)}
                                        disabled={loading || saving}
                                        aria-label={translate('reset.toDefault')}
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      {translate('reset.toDefault')}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                {showClear && (
                                  <Tooltip>
                                    <TooltipTrigger render={<span className="inline-flex" />}>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-foreground-muted hover:text-foreground"
                                        onClick={() => handleClear(key)}
                                        disabled={loading || saving}
                                        aria-label={translate('keyboard.removeShortcut')}
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      {translate('keyboard.removeShortcut')}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </TooltipProvider>
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-w-[80px] justify-end px-0 hover:bg-transparent dark:hover:bg-transparent"
                            onClick={() => startCapture(key)}
                            disabled={loading || saving}
                          >
                            <Shortcut hotkey={effectiveHotkey} variant="keycaps" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KeyboardSettingsCard;
