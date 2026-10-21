// #6264 「浏览器」页签里打开别的机器上的一个网页(`file:///…/x.html`,本机同一个动作):
// 页签实际加载 `gugu-preview://<id>/x.html`,字节经会话工作区的读文件动词从那台机器取(preview-protocol.ts),
// 地址栏照旧显示 `file:///…`(remote-page-url.ts)。
//
// 一个页签一份登记(= 一个 origin),同一页签里换页、点同目录的另一页都在这一份里;页签关掉就撤登记。
// 纯逻辑(取根、登记、撤登记注入),单测钉每条分支。
import { remotePageLoadUrl, remotePagePresentUrl } from '@shared/preview/remote-page-url';

export type RemotePageFailure = 'outside' | 'unavailable';

export type RemotePageSessionDeps = {
  /** 这条会话在那台机器上的工作目录。 */
  root: () => Promise<string>;
  /** 登记一份浏览器预览,拿回它的 id;登记不了 ⇒ null。 */
  register: (root: string) => Promise<string | null>;
  release: (previewId: string) => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

type Registered = { previewId: string; root: string };

export class RemotePageSession {
  private registered: Registered | null = null;
  private pending: Promise<Registered | null> | null = null;
  private disposed = false;

  constructor(private readonly deps: RemotePageSessionDeps) {}

  private async ensure(): Promise<Registered | null> {
    if (this.registered) return this.registered;
    this.pending ??= (async () => {
      try {
        const root = await this.deps.root();
        const previewId = await this.deps.register(root);
        if (!previewId) return null;
        if (this.disposed) {
          this.deps.release(previewId);
          return null;
        }
        this.registered = { previewId, root };
        return this.registered;
      } catch (error) {
        this.deps.log?.('remote page registration failed', { error: String(error) });
        return null;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** `file:` 地址 → 页签要加载的地址;或说清为什么开不了。 */
  async resolve(fileUrl: string): Promise<{ url: string } | { error: RemotePageFailure }> {
    const registered = await this.ensure();
    if (!registered) return { error: 'unavailable' };
    const url = remotePageLoadUrl(registered.previewId, registered.root, fileUrl);
    return url ? { url } : { error: 'outside' };
  }

  /** 页签报上来的地址 → 地址栏显示的地址(不是这一格的预览地址 ⇒ null,原样显示)。 */
  present(loadedUrl: string): string | null {
    const registered = this.registered;
    return registered ? remotePagePresentUrl(registered.previewId, registered.root, loadedUrl) : null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.registered) this.deps.release(this.registered.previewId);
    this.registered = null;
  }
}
