import { messageForUser } from '@/lib/userFacingError';
import { safeFailureLine } from '../gugu-reason';
import { detectPlatform } from '@tanstack/react-hotkeys';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import type { OpenedOutput } from '@gugu/session-chat-ui';
import { openedFilePath } from '@gugu/session-chat-ui/opened-outputs';
import type { ChatCommands } from '@renderer/lib/chat/chat-transcript';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { reopenSessionOutput } from '../stores/open-file-in-file-editor';

const PLATFORM = detectPlatform();
/** 与文件树右键「在访达中显示」同一个词(editor-file-tree)。 */
const REVEAL_LABEL_KEY =
  PLATFORM === 'mac' ? 'fileTree.revealFinder' : PLATFORM === 'windows' ? 'fileTree.revealExplorer' : 'fileTree.revealFileManager';

/**
 * 附件卡右边「侧边栏 ▾」那张菜单(#7193,「Open in ▾」):点整行是默认的「在侧边栏打开」
 * (对话右边并排,owner 10-15:「默认是打开在侧边栏」),这里列出全部打开方式。
 *
 * 用默认应用打开 / 在访达中显示只在会话就跑在这台电脑上时给:另一台机器上的文件这台电脑开不了,
 * ❌ 摆两条点了必失败的项。复制失败原因去敏后显示并记录。
 */
export function useOpenedOutputMenu({ projectId, sessionId }: { projectId: string; sessionId: string }): {
  commands: Pick<ChatCommands, 'outputOpenMode' | 'onOutputMenu'>;
  menu: ReactElement | null;
} {
  const { translate } = useSessionMessages();
  const [target, setTarget] = useState<{ output: OpenedOutput; anchor: HTMLElement } | null>(null);
  const local = machineRegistry.machineOf(projectId) === null;

  const commands = useMemo<Pick<ChatCommands, 'outputOpenMode' | 'onOutputMenu'>>(
    () => ({
      outputOpenMode: () => translate('transcript.outputMode.choose'),
      onOutputMenu: ({ output, anchor }) => setTarget({ output, anchor }),
    }),
    [translate]
  );

  const copy = useCallback(
    async (text: string, done: string) => {
      try {
        await rpc.app.clipboardWriteText(text);
        toast({ title: done });
      } catch (error) {
        log.error({ error }, 'opened-output copy failed');
        toast({ title: translate('task.copyFailed'), description: safeFailureLine(String((error as Error)?.message ?? error)), variant: 'destructive' });
      }
    },
    [translate]
  );

  const reveal = useCallback(
    async (path: string) => {
      const result = await rpc.app.showItemInFolder(path).catch((error: unknown) => ({ success: false as const, error }));
      if (!result.success) {
        log.error({ error: result.error, path }, 'opened-output reveal failed');
        toast({ title: translate('fileTree.showFailed'), description: messageForUser(result.error), variant: 'destructive' });
      }
    },
    [translate]
  );

  const openWithApp = useCallback(
    async (path: string) => {
      const result = await rpc.app.openPath(path).catch((error: unknown) => ({ success: false as const, error }));
      if (!result.success) {
        log.error({ error: result.error, path }, 'opened-output openPath failed');
        toast({ title: translate('transcript.outputMenu.app'), description: messageForUser(result.error), variant: 'destructive' });
      }
    },
    [translate]
  );

  const openInBrowser = useCallback(async (url: string) => {
    const result = await rpc.app.openExternal(url).catch((error: unknown) => ({ success: false as const, error }));
    if (result && 'success' in result && !result.success) log.error({ error: result.error, url }, 'opened-output openExternal failed');
  }, []);

  if (!target) return { commands, menu: null };
  const { output, anchor } = target;
  const filePath = openedFilePath(output);
  const close = () => setTarget(null);

  const menu = (
    <DropdownMenu open onOpenChange={(open) => (open ? undefined : close())}>
      <DropdownMenuContent anchor={anchor} align="end" className="w-auto" data-testid="opened-output-menu">
        <DropdownMenuItem onClick={() => reopenSessionOutput(projectId, sessionId, output)}>
          {translate('transcript.outputMenu.side')}
          <DropdownMenuShortcut>{translate('transcript.outputMenu.default')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {filePath ? (
          <>
            {local ? (
              <>
                <DropdownMenuItem onClick={() => void openWithApp(filePath)}>{translate('transcript.outputMenu.app')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void reveal(filePath)}>{translate(REVEAL_LABEL_KEY)}</DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem onClick={() => void copy(filePath, translate('fileTree.pathCopied'))}>{translate('task.copyPath')}</DropdownMenuItem>
          </>
        ) : output.kind === 'page' ? (
          <>
            <DropdownMenuItem onClick={() => void openInBrowser(output.url)}>{translate('transcript.outputMenu.browser')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(output.url, translate('transcript.outputMenu.linkCopied'))}>
              {translate('transcript.outputMenu.copyLink')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return { commands, menu };
}
