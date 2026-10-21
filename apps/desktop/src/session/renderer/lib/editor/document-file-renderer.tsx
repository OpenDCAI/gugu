import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { DocumentPreviewContent } from '@/components/chat/DocumentPreviewContent';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';

/**
 * 文件 tab 里的文档阅读器:PDF(#5269)与 Word / PPT / Excel(#7191)。
 *
 * owner 2026-09-10:「按理说应该原生支持 pdf 等文件阅读来着」;2026-10-15 Office 也定为「咕咕里预览」。
 * 这些文件从前被当成「二进制」或文本,画出来是一张「不支持的文件格式」占位卡。
 *
 * ⚠️ 渲染本身**复用主 app 聊天里那份** `DocumentPreviewContent`(pdf.js / docx-preview /
 * @aiden0z/pptx-renderer / @silurus/ooxml,都是动态 import 的 chunk)。❌ 别在这儿另起一份渲染:
 * 同一件事两份实现,下次就要两边同步。
 */
export const DocumentFileRenderer = observer(function DocumentFileRenderer({
  file,
  kind,
  projectId,
  workspaceId,
  openAction,
  onOpenExternally,
}: {
  file: { path: string };
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx';
  projectId: string;
  workspaceId: string;
  /** 读不出来 / 渲染不了时,给人的下一步(本机文件:用系统默认程序打开;别的机器上:下载)。 */
  openAction?: ReactNode;
  /** Excel 太大只显示了一部分时,提示条上那个「用 Office 软件打开」。 */
  onOpenExternally?: () => void;
}) {
  const { translate } = useSessionMessages();
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileName = file.path.split('/').pop() ?? file.path;
  // 盘上换了这个文件就重读一次(和图片同一个版本号)。
  const diskVersion = modelRegistry.diskVersion(workspaceId, file.path);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void (async () => {
      const result = await workspaceRpc(projectId).files.readInlineBinary(projectId, workspaceId, file.path);
      if (cancelled) return;
      if (!result.success) {
        setError('message' in result.error ? result.error.message : String(result.error));
        return;
      }
      if (!result.data.success) {
        setError(result.data.error);
        return;
      }
      // data URL → 字节。pdf.js 要的是 ArrayBuffer,❌ 不能直接把 data: 丢给它当 url
      // (那条路会再解一次码,而且大文件会在字符串上翻倍)。
      const base64 = result.data.dataUrl.slice(result.data.dataUrl.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      setData(bytes.buffer);
    })();
    return () => {
      cancelled = true;
    };
  }, [file.path, projectId, workspaceId, diskVersion]);

  if (error) {
    return (
      <div className="text-foreground-muted flex h-full flex-col items-center justify-center p-4 text-center text-sm">
        <p>{error}</p>
        {openAction}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-foreground-muted flex h-full items-center justify-center p-4 text-sm">
        {translate('file.loadingDocument')}
      </div>
    );
  }
  return <DocumentPreviewContent kind={kind} content={data} title={fileName} onOpenExternally={onOpenExternally} />;
});
