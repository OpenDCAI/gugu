/**
 * FILE_CONTENT_TYPES — single source of truth for file rendering capabilities.
 *
 * Each entry declares:
 *   editable  — true when the file has a Monaco source view (text/csv/markdown/html/svg)
 *   Preview   — present when the file has a rendered preview component
 *
 * The FileContent container derives showSource / showPreview / canToggle from these
 * two flags plus FileTabStore.viewMode. No other mapping or coupling is needed.
 */

import { observer } from 'mobx-react-lite';
import type { ComponentType } from 'react';
import { BinaryRenderer } from '@renderer/lib/editor/binary-renderer';
import { CsvRenderer } from '@renderer/lib/editor/csv-renderer';
import { FileErrorRenderer } from '@renderer/lib/editor/file-error-renderer';
import { HtmlRenderer } from '@renderer/lib/editor/html-renderer';
import { ImageRenderer } from '@renderer/lib/editor/image-renderer';
import { MarkdownEditorRenderer } from '@renderer/lib/editor/markdown-renderer';
import { DocumentFileRenderer } from '@renderer/lib/editor/document-file-renderer';
import { SvgRenderer } from '@renderer/lib/editor/svg-renderer';
import { TooLargeRenderer } from '@renderer/lib/editor/too-large-renderer';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceBackend } from '../workspace-backend/workspace-backend';
import { openPathWithFailureToast } from '../stores/open-file-in-file-editor';
import { resolveWorkspacePath } from '../stores/workspace-path';
import type { FileContentType } from './stores/file-tab-resource';
import type { FileTabResource } from './stores/file-tab-resource';

export interface FileContentTypeDef {
  /** True when the file type supports Monaco source editing. */
  editable: boolean;
  /**
   * Present when the file type has a rendered preview component.
   *
   * ⚠️ 带上 `ctx`:PDF 那一支要自己去读整块字节,而**外部文件的 resource 上没有工作区上下文**
   * (`_modelCtx` 只在非外部文件上建),寻址只能靠 tab 的上下文(#5269)。其余渲染器忽略它即可。
   */
  Preview?: ComponentType<{ tab: FileTabResource; ctx: SessionTabContext }>;
}

// Stable wrapper components so React never sees a new reference on re-render.

function CsvPreview({ tab }: { tab: FileTabResource }) {
  return <CsvRenderer tab={tab} />;
}

function MarkdownPreview({ tab }: { tab: FileTabResource }) {
  return <MarkdownEditorRenderer tab={tab} />;
}

function HtmlPreview({ tab }: { tab: FileTabResource }) {
  return <HtmlRenderer tab={tab} />;
}

function SvgPreview({ tab }: { tab: FileTabResource }) {
  return <SvgRenderer tab={tab} />;
}

// observer:图片的字节在 tab.content 上,盘上换了文件、重读回来时得跟着重画(ImageRenderer 自己不是 observer)。
const ImagePreview = observer(function ImagePreview({ tab }: { tab: FileTabResource }) {
  return <ImageRenderer file={{ path: tab.path, content: tab.content }} />;
});

/**
 * PDF / Word / PPT / Excel 自己去把字节读回来 —— 要的是整块二进制,而 `FileContentPreview` 那条外部读取走的是
 * `readText`(#5269)。工作区 id 从 tab 的模型上下文拿。
 */
function documentPreview(kind: 'pdf' | 'docx' | 'pptx' | 'xlsx') {
  return function DocumentPreview({ tab, ctx }: { tab: FileTabResource; ctx: SessionTabContext }) {
    return (
      <DocumentFileRenderer
        file={tab}
        kind={kind}
        projectId={ctx.projectId}
        workspaceId={ctx.workspaceId}
        openAction={<OpenOrDownload tab={tab} ctx={ctx} />}
        onOpenExternally={isRemote(ctx) ? undefined : () => void openPathWithFailureToast(absolutePath(tab, ctx), fileWorkspace(tab, ctx))}
      />
    );
  };
}

const PdfPreview = documentPreview('pdf');
const DocxPreview = documentPreview('docx');
const PptxPreview = documentPreview('pptx');
const XlsxPreview = documentPreview('xlsx');

/** 工作区在别的机器上(远程会话):那边的文件这台电脑的系统程序打不开,只能下载。 */
function isRemote(ctx: SessionTabContext): boolean {
  return Boolean(workspaceBackend(ctx.projectId).tree.download);
}

function absolutePath(tab: FileTabResource, ctx: SessionTabContext): string {
  return resolveWorkspacePath(ctx.workspacePath, tab.path);
}

/** 工作区里的文件说出是哪个工作区(它可能在 home 外,主进程据此放行);工作区外的(附件等)不带,只认 home。 */
function fileWorkspace(tab: FileTabResource, ctx: SessionTabContext): FileWorkspace | undefined {
  return tab.isExternal ? undefined : { projectId: ctx.projectId, workspaceId: ctx.workspaceId };
}

/**
 * 看不了 / 太大的文件,这台电脑上的给「用系统默认程序打开」(#7191,owner 2026-10-15:Office 文件
 * 「咕咕里预览」,画不出来的也不能是死路)。别的机器上的照旧给下载。
 */
function OpenOrDownload({ tab, ctx }: { tab: FileTabResource; ctx: SessionTabContext }) {
  // 远程会话里工作区外的文件也在那台机器上(字节是经那台机器读回来的):系统程序在这台电脑上,够不着它。
  // DownloadInstead 对它不画按钮 —— ❌ 给一个打开本机同名路径的按钮。
  if (isRemote(ctx)) return <DownloadInstead tab={tab} ctx={ctx} />;
  return <OpenWithSystemButton absolutePath={absolutePath(tab, ctx)} workspace={fileWorkspace(tab, ctx)} />;
}

type FileWorkspace = { projectId: string; workspaceId: string };

/** 这台电脑上的文件交给系统默认程序。新建任务的草稿文件面板也用这一个(那里只有本机文件)。 */
export function OpenWithSystemButton({ absolutePath, workspace }: { absolutePath: string; workspace?: FileWorkspace }) {
  const { translate } = useSessionMessages();
  return (
    <Button size="sm" variant="outline" className="mt-4" onClick={() => void openPathWithFailureToast(absolutePath, workspace)}>
      {translate('file.openWithSystem')}
    </Button>
  );
}

/**
 * 看不了 / 太大的文件,在别的机器上时照 VS Code 远程给「下载到这台电脑」(❌ 只说一句不支持就完)。
 * 这台电脑上的文件本来就在这里,工作区后端不给下载 —— 按钮不画。
 */
function DownloadInstead({ tab, ctx }: { tab: FileTabResource; ctx: SessionTabContext }) {
  const { translate } = useSessionMessages();
  const tree = workspaceBackend(ctx.projectId).tree;
  if (!tree.download || tab.isExternal) return null;
  const name = tab.path.split('/').pop() ?? tab.path;
  return (
    <Button
      size="sm"
      variant="outline"
      className="mt-4"
      onClick={() =>
        void tree.download?.(
          { projectId: ctx.projectId, workspaceId: ctx.workspaceId, rootPath: ctx.workspacePath ?? '', files: null },
          { path: tab.path, name, kind: 'file', size: tab.totalSize ?? undefined }
        )
      }
    >
      {translate('file.downloadInstead')}
    </Button>
  );
}

function TooLargePreview({ tab, ctx }: { tab: FileTabResource; ctx: SessionTabContext }) {
  return <TooLargeRenderer file={tab} action={<OpenOrDownload tab={tab} ctx={ctx} />} />;
}

function BinaryPreview({ tab, ctx }: { tab: FileTabResource; ctx: SessionTabContext }) {
  return <BinaryRenderer file={tab} action={<OpenOrDownload tab={tab} ctx={ctx} />} />;
}

function FileErrorPreview({ tab }: { tab: FileTabResource }) {
  return <FileErrorRenderer file={tab} />;
}

export const FILE_CONTENT_TYPES: Record<FileContentType, FileContentTypeDef> = {
  text: { editable: true },
  csv: { editable: true, Preview: CsvPreview },
  markdown: { editable: true, Preview: MarkdownPreview },
  html: { editable: true, Preview: HtmlPreview },
  svg: { editable: true, Preview: SvgPreview },
  image: { editable: false, Preview: ImagePreview },
  pdf: { editable: false, Preview: PdfPreview },
  docx: { editable: false, Preview: DocxPreview },
  pptx: { editable: false, Preview: PptxPreview },
  xlsx: { editable: false, Preview: XlsxPreview },
  'too-large': { editable: false, Preview: TooLargePreview },
  binary: { editable: false, Preview: BinaryPreview },
  'file-error': { editable: false, Preview: FileErrorPreview },
};
