import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { DEFAULT_CHAT_VIEW } from '@renderer/lib/chat/use-session-chat-layout';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 对话视图选择器（#4874）。与「色彩模式」那张卡片(原 ThemeCard,主题已归壳的设置 → 通用)同一形状——owner 2026-09-04
 * 指名照那个做：两张并排大卡、一眼看出差别，❌ 不是一个只有文字的分段控件。
 *
 * 卡面画的是**版式示意**而不是图标：单栏每行整宽，双栏把用户消息推到右侧、左边留白。示意图纯用现有 token 的色块拼，不引第三方插画、不写死颜色。
 */

type ChatView = 'single' | 'double';

type Props = { disabled?: boolean };

const barBase = 'rounded-sm bg-foreground-muted/35';

/** 单栏：每行整宽。 */
const SinglePreview: React.FC = () => (
  <div className="flex w-full flex-col gap-1" aria-hidden="true">
    <div className={`${barBase} h-1 w-full`} />
    <div className={`${barBase} h-1 w-full`} />
    <div className={`${barBase} h-1 w-4/5`} />
  </div>
);

/** 双栏：用户消息靠右且留出左栏，assistant 回到整宽。 */
const DoublePreview: React.FC = () => (
  <div className="flex w-full flex-col gap-1" aria-hidden="true">
    <div className="flex justify-end">
      <div className={`${barBase} h-1 w-1/2`} />
    </div>
    <div className={`${barBase} h-1 w-full`} />
    <div className={`${barBase} h-1 w-4/5`} />
  </div>
);

const ChatViewCard: React.FC<Props> = ({ disabled }) => {
  const { translate } = useSessionMessages();
  const {
    value: interfaceSettings,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('interface');
  // 兜底走同一个常量，不写字面量 —— 见 DEFAULT_CHAT_VIEW 的注释（#4981 D10）：
  // 这张卡片高亮哪一档，必须和 transcript 那一刻真正渲染的档一致。
  const chatView: ChatView = interfaceSettings?.chatView ?? DEFAULT_CHAT_VIEW;
  const busy = disabled || loading || saving;

  const choose = (next: ChatView) => {
    if (chatView !== next) update({ chatView: next });
  };

  const buttonBase =
    'flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg border px-2 py-3 text-sm font-medium transition-colors sm:px-3';
  const activeClass = 'bg-background-2';
  const inactiveClass =
    'border-foreground/10 bg-background text-foreground-muted hover:bg-row-hover';

  const option = (value: ChatView, label: string, preview: React.ReactNode) => (
    <button
      type="button"
      onClick={() => choose(value)}
      disabled={busy}
      className={`${buttonBase} ${chatView === value ? activeClass : inactiveClass}`}
      aria-pressed={chatView === value}
      aria-label={label}
      data-chat-view-option={value}
    >
      <span className="flex w-full max-w-24 justify-center px-1">{preview}</span>
      <span className="text-center">{label}</span>
    </button>
  );

  return (
    <SettingsGroup
      data-testid="settings-chat-view"
      title={translate('settings.chatView')}
      note={translate('settings.chatViewDescription')}
    >
      <SettingsRow>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2 text-sm">
          {option('single', translate('settings.chatViewSingle'), <SinglePreview />)}
          {option('double', translate('settings.chatViewDouble'), <DoublePreview />)}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
};

export default ChatViewCard;
