import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  LOCAL_SESSION_ENGINE_LABEL,
  type LocalSessionPreview,
  type LocalSessionRow,
} from '@shared/core/session-import/session-import';
import type { SessionImportSource } from './import-source';

// @@@sessionpage 导入本机会话 (spec session-page-import)：选中一条后的确认视图。
// 列表那一行只有标题（来自文件头部），光看标题分不清「哪一条」——尤其是同一个项目里
// 反复开的会话。这里真读一次原件，给出真实轮数与首尾几轮，用户按内容确认，不是按猜。

function TurnBubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-tiny text-foreground-tertiary-muted">
        {/* role 是稳定枚举，只在展示边界映射成本地化标签；轮次正文原样呈现。 */}
        {translate(role === 'user' ? 'sessionImport.roleUser' : 'sessionImport.roleAgent')}
      </span>
      <p className="line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground-muted">
        {content}
      </p>
    </div>
  );
}

export function SessionPreviewPane({
  session,
  source,
  describeError,
}: {
  session: LocalSessionRow | null;
  /** #6264 读哪台机器上的原件(与列表同一个 source)。 */
  source: SessionImportSource;
  /** 读失败时说给人听的整句(本机 / 别的机器说法不同)。 */
  describeError: (error: unknown) => string;
}) {
  const { translate } = useSessionMessages();
  const [preview, setPreview] = useState<LocalSessionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // 说法随语言变,但语言一变 ❌ 重读原件。
  const describeErrorRef = useRef(describeError);
  describeErrorRef.current = describeError;

  useEffect(() => {
    if (!session) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    source
      .preview({ filePath: session.filePath, engine: session.engine })
      .then((next) => {
        if (cancelled) return;
        setPreview(next);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 文件可能已被删/移走（清单来自索引缓存）——直说，别给一个空白的预览。
        setError(describeErrorRef.current(e));
        setPreview(null);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, source]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionImport.previewEmptyTitle')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground">{preview?.title ?? session.title}</span>
        <span className="text-xs break-all text-foreground-muted" title={session.cwd ?? undefined}>
          {session.cwd ?? translate('sessionImport.unknownDirectory')}
        </span>
        <span className="text-xs text-foreground-tertiary-muted">
          {LOCAL_SESSION_ENGINE_LABEL[session.engine]}
          {preview
            ? ` · ${translate('sessionImport.previewTurnCount', { count: preview.turnCount })}`
            : ''}
        </span>
      </div>

      {isLoading && !preview ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner size="sm" />
          {translate('sessionImport.previewLoading')}
        </div>
      ) : null}

      {error ? (
        <p className="text-xs leading-relaxed text-foreground-destructive">
          {/* 已是整句(describeImportFailure):本机的诊断原样穿过外壳,别的机器按原因说人话。 */}
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {preview.head.map((turn, index) => (
            <TurnBubble key={`head-${index}`} role={turn.role} content={turn.content} />
          ))}
          {preview.turnCount > preview.head.length + preview.tail.length ? (
            <span className="text-tiny text-foreground-tertiary-muted">
              {translate('sessionImport.previewOmitted', {
                count: preview.turnCount - preview.head.length - preview.tail.length,
              })}
            </span>
          ) : null}
          {preview.tail.map((turn, index) => (
            <TurnBubble key={`tail-${index}`} role={turn.role} content={turn.content} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
