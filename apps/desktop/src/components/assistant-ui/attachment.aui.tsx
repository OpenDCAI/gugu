import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { MAX_ATTACHMENT_BYTES } from "@gugu/session-core/session-record/contract";
import {
  ComposerAttachmentChip,
  MessageProvider,
  formatAttachmentSize,
} from "@gugu/session-ui/react/components";
import { ThemeProvider as SessionUiThemeProvider } from "@gugu/session-ui/react/primitives";
import { useLocale } from "@/i18n";
import { Paperclip as PaperclipIcon } from "@/lib/icons";
import { useTheme } from "../../store/theme";
import { useAuiCopy } from "./copy";
import { TooltipIconButton } from "./tooltip-icon-button";

/**
 * 附件三件套。附件块就是电脑输入框那枚 `ComposerAttachmentChip`(进度、失败原因、重传、移除),两端长一个样;
 * 这里只把 assistant-ui 的 `attachment.status` 翻成它的入参。适配器见 mobile/agent-watch/composer-attachments.ts。
 */

const CHIP_KEYS: Record<string, string> = {
  "composer.removeAttachment": "assistantUi.attachment.remove",
  "composer.cancelAttachment": "assistantUi.attachment.cancel",
  "composer.retryAttachment": "assistantUi.attachment.retry",
};

/** session-ui 的件要它自己的主题变量与文案口(与聊天页的 AgentPermissionBand 同一套接法)。 */
function ChipProviders({ children }: { children: ReactNode }) {
  const { t } = useTranslation("main");
  const { resolvedLocale } = useLocale();
  const { theme } = useTheme();
  const translate = useCallback(
    (key: string, values?: Readonly<Record<string, string | number>>) => {
      if (!CHIP_KEYS[key]) throw new Error(`Missing attachment chip translation: ${resolvedLocale}:${key}`);
      return t(CHIP_KEYS[key], values);
    },
    [resolvedLocale, t],
  );
  return (
    <SessionUiThemeProvider theme={theme} target="documentElement">
      <MessageProvider locale={resolvedLocale} translate={translate}>
        {children}
      </MessageProvider>
    </SessionUiThemeProvider>
  );
}

/** 图片附件的缩略图:手上有这件文件(输入框里)才有,发出去之后只剩名字。 */
function useImageSrc(file: File | undefined): string | undefined {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!file) return setSrc(undefined);
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src;
}

const AttachmentChip: FC<{ composer?: boolean }> = ({ composer = false }) => {
  const aui = useAui();
  const { id, name, type, status, file } = useAuiState((s) => s.attachment);
  const previewUrl = useImageSrc(type === "image" ? file : undefined);
  const failed = status.type === "incomplete";
  const percent = status.type === "running" ? Math.floor(status.progress * 100) : null;
  // 超上限的重传也还是超(与上传函数同一个数),就不给重传。
  const retryable = composer && failed && !!file && file.size <= MAX_ATTACHMENT_BYTES;
  const retry = async () => {
    await aui.attachment.remove();
    if (file) await aui.composer.addAttachment(file);
  };
  return (
    <ComposerAttachmentChip
      attachment={{
        id,
        name,
        kind: type === "image" ? "image" : "file",
        ...(previewUrl ? { previewUrl } : {}),
        state: failed ? "error" : percent !== null ? "uploading" : "done",
        ...(percent !== null ? { progress: percent } : {}),
        meta: failed ? status.message : percent !== null ? `${percent}%` : file ? formatAttachmentSize(file.size) : undefined,
        cancelable: composer,
        retryable,
      }}
      onRemove={composer ? () => void aui.attachment.remove() : undefined}
      onRetry={retryable ? () => void retry() : undefined}
    />
  );
};

export const UserMessageAttachments: FC = () => (
  <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row flex-wrap justify-end gap-2 empty:hidden">
    <ChipProviders>
      <MessagePrimitive.Attachments>{() => <AttachmentChip />}</MessagePrimitive.Attachments>
    </ChipProviders>
  </div>
);

export const ComposerAttachments: FC = () => (
  <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
    <ChipProviders>
      <ComposerPrimitive.Attachments>{() => <AttachmentChip composer />}</ComposerPrimitive.Attachments>
    </ChipProviders>
  </div>
);

/** 回形针:只在 runtime 接了附件适配器时出现(新建会话页没接),❌ 摆一个点了没反应的按钮。 */
export const ComposerAddAttachment: FC = () => {
  const c = useAuiCopy();
  return (
    <AuiIf condition={(s) => s.thread.capabilities.attachments}>
      <ComposerPrimitive.AddAttachment asChild>
        <TooltipIconButton
          tooltip={c.attachmentAdd}
          side="bottom"
          className="aui-composer-add-attachment text-muted-foreground hover:text-foreground size-7 rounded-full"
          data-testid="agent-watch-attach"
        >
          <PaperclipIcon className="size-4" />
        </TooltipIconButton>
      </ComposerPrimitive.AddAttachment>
    </AuiIf>
  );
};
