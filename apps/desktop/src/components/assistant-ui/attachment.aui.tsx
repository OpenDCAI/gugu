import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ComposerAttachmentChip,
  MessageProvider,
  formatAttachmentSize,
} from "@gugu/session-ui/react/components";
import { ThemeProvider as SessionUiThemeProvider } from "@gugu/session-ui/react/primitives";
import { useLocale } from "@/i18n";
import { useTheme } from "../../store/theme";

/**
 * 消息里的附件沿用共享 ComposerAttachmentChip；输入框的附件由 ChatComposer 统一渲染。
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

const AttachmentChip: FC = () => {
  const { id, name, type, status, file } = useAuiState((s) => s.attachment);
  const previewUrl = useImageSrc(type === "image" ? file : undefined);
  const failed = status.type === "incomplete";
  const percent = status.type === "running" ? Math.floor(status.progress * 100) : null;
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
      }}
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
