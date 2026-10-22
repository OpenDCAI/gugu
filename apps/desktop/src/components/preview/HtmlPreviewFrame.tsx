import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { useEffect, useRef, useState } from 'react';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { PREVIEW_LINK_MESSAGE_TYPE } from '@/session/shared/preview/preview-link-script';

/** 登记一次预览的结果:拿到地址,或一句「起不来」的原因(画在预览位置上)。 */
export type HtmlPreviewRegistration =
  | { ok: true; url: string; update: (html: string) => Promise<string>; release: () => void }
  | { ok: false; message: string };

interface HtmlPreviewFrameProps {
  fileName: string;
  rawContent: string;
  /**
   * 登记这份文档的预览(带登记那一刻的正文)。**它的身份变了才重新登记** —— 调用方用 useCallback
   * 按「哪个文件」记住它;正文变了不重登记,只推新正文(见下)。
   */
  register: (documentHtml: string) => Promise<HtmlPreviewRegistration>;
  /** 页面里要离开这个预览的点击(注入脚本 postMessage 过来的 href)。 */
  onLink: (href: string) => void;
  /**
   * 变了就重载一次(#6264 别的机器上:同一目录里存了别的文件 / agent 一轮干完改了东西 —— 旁边的样式、脚本
   * 只有磁盘那一份,文档正文没变也要重取)。不给 = 只跟着正文走。
   */
  reloadKey?: number;
}

/**
 * 预览本体:本机与 #6264 别的机器上的「文件」页签共用 —— 两边只差「登记走哪条」「链接开到哪」,
 * 这两样由调用方注入;地址、沙箱、改字即见、链接拦截只写这一份。
 */
export function HtmlPreviewFrame({ fileName, rawContent, register, onLink, reloadKey }: HtmlPreviewFrameProps) {
  const [preview, setPreview] = useState<Extract<HtmlPreviewRegistration, { ok: true }> | null>(null);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // 登记时带的是**登记那一刻**的正文,所以这里要一份不随 effect 依赖走的引用。
  const rawContentRef = useRef(rawContent);
  rawContentRef.current = rawContent;
  /** 登记时已经发过去的那一份 —— 用它把「第一次加载」和「改了字」分开,别白重载一次。 */
  const registeredContentRef = useRef<string | null>(null);
  /** 登记没起来之后,`reloadKey` 再变(那台机器回来了 / 文件变了)就重新登记一次。 */
  const [attempt, setAttempt] = useState(0);

  // frame 只管理一次登记的生命周期;协议登记或 Blob 的更新/撤销由传输适配提供。
  useEffect(() => {
    let cancelled = false;
    let registered: Extract<HtmlPreviewRegistration, { ok: true }> | null = null;
    setPreview(null);
    setFailed(null);
    void (async () => {
      const content = rawContentRef.current;
      const result = await register(content);
      if (cancelled) {
        if (result.ok) result.release();
        return;
      }
      if (!result.ok) {
        // 预览起不来要说是哪一条起不来,❌ 别画一张白页让人以为文件是空的。
        setFailed(result.message);
        return;
      }
      registered = result;
      registeredContentRef.current = content;
      setUrl(result.url);
      setPreview(result);
    })().catch((error: unknown) => {
      if (!cancelled) setFailed(error instanceof Error ? error.message : 'Preview unavailable');
    });
    return () => {
      cancelled = true;
      registered?.release();
    };
  }, [register, attempt]);

  // 预览看的是**编辑器缓冲区**,不是磁盘那一份:改一个字、切到预览就该看见,不必先保存。
  // 更新后的地址由适配给出:协议追加版本,Blob 重建地址;frame 不判断平台。
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!preview) return;
    // 登记时那一份已经发过去了,这里不重复推一遍 —— 否则每次打开预览都要白加载两次。
    if (registeredContentRef.current === rawContent) return;
    let cancelled = false;
    void preview.update(rawContent).then((nextUrl) => {
      if (cancelled) return;
      registeredContentRef.current = rawContent;
      setFailed(null);
      setUrl(nextUrl);
    }).catch((error: unknown) => {
      if (!cancelled) setFailed(error instanceof Error ? error.message : 'Preview unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [preview, rawContent, revision]);

  const seenReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (seenReloadKey.current === reloadKey) return;
    seenReloadKey.current = reloadKey;
    // 上次没登记上(别的机器上的页面:那台机器一时没应答):重新登记,❌ 一直停在那句失败上。
    if (failed) setAttempt((n) => n + 1);
    else {
      registeredContentRef.current = null;
      setRevision((n) => n + 1);
    }
  }, [reloadKey, failed]);

  // 页面里要离开这个预览的点击由注入脚本 postMessage 过来,交给调用方决定开到哪去。
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; href?: string } | null;
      if (!data || data.type !== PREVIEW_LINK_MESSAGE_TYPE || typeof data.href !== 'string') return;
      onLink(data.href);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onLink]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background-secondary-1 px-6 text-center text-xs text-foreground-passive">
        {failed}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background-secondary-1">
      {preview ? (
        <iframe
          ref={iframeRef}
          title={fileName}
          src={url}
          // allow-scripts:让页面自己的脚本与那段链接拦截跑起来。
          // 仍然不给 allow-same-origin —— 这一条与地址是两回事:**地址决定 URL 怎么解析,
          // 源决定它能读到什么**。有了地址,锚点和相对路径已经对了;不给同源,它就读不到自己
          // 这个 origin 下的存储、也发不出同源请求。两样都要。
          sandbox="allow-scripts"
          className="w-full min-h-0 flex-1 border-0"
          style={{ background: 'var(--bg-primary)' }}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <LoadingIndicator ariaLabel={translateSessionMessage('task.loading')} />
        </div>
      )}
    </div>
  );
}
