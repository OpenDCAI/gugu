import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import { useCallback, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { Avatar } from '@/components/Avatar';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { Palette, X } from '@/lib/icons';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { composeInstructions, joinPersona, PERSONA_PRESETS, splitPersona, type PersonaPreset } from './assistant-files';
import { readText, writeText } from './assistant-machine';
import { useInstructions, useInvalidateAssistant } from './assistant-data';
import { useAssistantReadError, useReadFailure } from './assistant-read-failure';
import type { AssistantContext } from './assistant-context';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';

/**
 * 性格(character + 「描述你希望助理如何说话和表现。留空可清除。」):
 * 存在云电脑 ~/.claude/CLAUDE.md 里管家那段之外的部分 —— 它每次开工都读。管家那段(「你是谁」「怎么做」)不在这里改:
 * 每次开通 / 升级都整段覆盖,改了也留不住;这里写的接在它后面,管家不动。读写都要云电脑醒着。
 */
export function usePersona(context: AssistantContext) {
  const instructions = useInstructions(context.machine);
  const user = instructions.data?.user ?? null;
  return { instructions, user, ...(user === null ? { preset: null, rest: '' } : splitPersona(user)) };
}

/** 「自定义」:头像(换形象 = 形象工坊)、名字、性格,一个「保存」。 */
export function CustomizeDialog({ context, onClose }: { context: AssistantContext; onClose: () => void }) {
  const { t } = useTranslation('assistant');
  const { toast } = useToast();
  const invalidate = useInvalidateAssistant(context.homeDeviceId);
  const persona = usePersona(context);
  const personaReadable = persona.user !== null && !!context.machine;
  const [name, setName] = useState(context.assistant.display_name);
  const [preset, setPreset] = useState<PersonaPreset | null>(persona.preset);
  const [rest, setRest] = useState(persona.rest);
  const [touched, setTouched] = useState(false);
  const revision = useRef<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 读到之前打开的:读到那一刻把读到的填进来(人还没动过的话)。
  if (!touched && personaReadable && (preset !== persona.preset || rest !== persona.rest)) {
    setPreset(persona.preset);
    setRest(persona.rest);
  }
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    if (!touched) revision.current = persona.instructions.data?.revision;
    setTouched(true);
    set(value);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const actions = readAssistantShellBridge()?.getActions();
      const trimmed = name.trim();
      if (trimmed && trimmed !== context.assistant.display_name) {
        if (!actions) throw new Error(t('customize.shellMissing'));
        await actions.renameAssistant(trimmed);
      }
      if (touched && personaReadable) {
        const machine = context.machine!;
        // 写之前现读一遍:管家那段取此刻的原文(打开对话框之后它可能刚被升级过)。
        const current = machine.panel ? '' : (await readText(machine, machine.paths.instructions)) ?? '';
        await writeText(machine, machine.paths.instructions, composeInstructions(current, joinPersona(preset, rest)),revision.current);
        if (!machine.panel) await reportAssistantAppChange(machine, context.assistant.id, { resource: 'personality', operation: 'edited',
          id: machine.paths.instructions, deviceId: context.homeDeviceId, after: { path: machine.paths.instructions } });
        await invalidate('instructions');
      }
      toast({ title: t('customize.saved') });
      onClose();
    } catch (cause) {
      setError(t('customize.saveFailed', { message: assistantPanelFailure(cause,t) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="ta-dialog sm:max-w-md" showCloseButton={false} data-testid="assistant-customize">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="ta-dialog-title">{t('customize.title')}</h2>
            <button type="button" className="ta-circle" aria-label={t('common.cancel')} onClick={onClose} disabled={saving}>
              <X />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <Avatar name={name || context.assistant.display_name} avatarUrl={context.assistant.avatar} seed={context.assistant.id} size={64} isAgent harnessBadge={false} />
            <label className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="ta-field-label">{t('customize.name')}</span>
              <input className="ta-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="assistant-customize-name" />
            </label>
          </div>
          <button
            type="button"
            className="ta-wide-btn"
            onClick={() => {
              readAssistantShellBridge()?.getActions()?.openLook();
              onClose();
            }}
            data-testid="assistant-customize-look"
          >
            <Palette />
            {t('customize.look')}
          </button>
          <div className="flex flex-col gap-2">
            <span className="ta-field-label">{t('customize.character')}</span>
            {personaReadable ? (
              <>
                <div className="ta-chips" role="group" aria-label={t('customize.character')}>
                  {PERSONA_PRESETS.map((key) => (
                    <button key={key} type="button" aria-pressed={preset === key} onClick={() => edit(setPreset)(preset === key ? null : key)} data-testid={`assistant-persona-${key}`}>
                      {t(`customize.preset.${key}`)}
                    </button>
                  ))}
                </div>
                <textarea
                  className="ta-input"
                  value={rest}
                  placeholder={t('customize.describe')}
                  onChange={(e) => edit(setRest)(e.target.value)}
                  data-testid="assistant-persona-text"
                />
              </>
            ) : (
              <PersonaPending context={context} instructions={persona.instructions} />
            )}
          </div>
          {error ? <p className="text-sm text-foreground-destructive">{error}</p> : null}
          <button type="button" className="ta-wide-btn" data-tone="primary" onClick={() => void save()} disabled={saving || !name.trim()} data-testid="assistant-customize-save">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 性格还读不到时那一格:正在连接(收回着的云端宿主由系统叫起来,owner 10-17 ❌「在休息 / 叫醒它」)/ 连不上(原因 + 重试)/
 * 连上了在读 / 连上了却没读成(打不开它存东西的地方、读那份设置出错:说原因 + 重试,❌ 一直转)。
 */
const PersonaPending = observer(function PersonaPending({
  context,
  instructions,
}: {
  context: AssistantContext;
  instructions: ReturnType<typeof usePersona>['instructions'];
}) {
  const { t } = useTranslation('assistant');
  const name = context.assistant.display_name;
  const readError = useAssistantReadError(context.machineLoading || instructions.isLoading,context.machineError ?? instructions.error);
  const machineError = Boolean(context.machineError);
  const { retryMachine } = context;
  const { refetch } = instructions;
  const reread = useCallback(() => (machineError ? retryMachine() : void refetch()), [machineError, retryMachine, refetch]);
  const failure = useReadFailure(readError, null, name, reread);
  if (failure)
    return (
      <div className="ta-input ta-page-sub flex items-center justify-between gap-3">
        <span role={failure.tone === 'danger' ? 'alert' : 'status'} data-testid="assistant-persona-read-failed">
          {failure.text}
        </span>
        {failure.retry ? (
          <button type="button" className="ta-pill-btn" onClick={failure.retry}>
            {t('machine.retry')}
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="ta-input ta-page-sub flex items-center gap-2">
      <LoadingIndicator size="inline" />
    </div>
  );
});
