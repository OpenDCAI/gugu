import { BUNDLE_STALL_TIMEOUT_MS } from '@shared/extensions/market';
import type { BundleDownloadOptions, MarketBackend } from './market-catalog';

/**
 * 下载站的 `market/` 根,市场从这里读目录、取包(地址在 updateFeeds.json,market-catalog-root.ts 接线)。公开的,不要登录。
 * 不 import electron:慢、卡住、超长这几样可以对着假的回答判。
 */
export class DownloadSiteMarketBackend implements MarketBackend {
  constructor(
    private readonly base: string,
    /** Nothing new for this long — the wait for the answer included — and the read fails. */
    private readonly stallMs = BUNDLE_STALL_TIMEOUT_MS,
    private readonly fetchFile: typeof fetch = fetch
  ) {}

  urlOf(relativePath: string): string {
    return new URL(relativePath, this.base).toString();
  }

  async readText(relativePath: string): Promise<string> {
    return new TextDecoder().decode(await this.read(relativePath));
  }

  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    return this.read(relativePath, options);
  }

  /**
   * One file, its bytes as they come. A slow line is no failure — only nothing new for `stallMs` is (161 10-16: a limit on the
   * whole file of 30 s meant 咕咕办公's 1.09 MB never came down below ~36 kB/s, and the first-run set only ever said 「next
   * start」; owner: 「只要保证初次用户体验稳定就行」). More than the index recorded stops at once (`expectedBytes`): ❌ read it all
   * first and compare — by then a swapped giant is in memory.
   */
  private async read(relativePath: string, options?: BundleDownloadOptions): Promise<Uint8Array> {
    const controller = new AbortController();
    const stalled = () => controller.abort(new Error(`market ${relativePath}: nothing came for ${Math.round(this.stallMs / 1000)} s`));
    let timer = setTimeout(stalled, this.stallMs);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(stalled, this.stallMs);
    };
    // Whatever is waiting (the answer, the next bytes) ends when it stalls — whichever fetch it is.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    aborted.catch(() => undefined);
    try {
      const response = await Promise.race([this.fetchFile(this.urlOf(relativePath), { signal: controller.signal }), aborted]);
      if (!response.ok) throw new Error(`market ${relativePath}: HTTP ${response.status}`);
      if (!response.body) throw new Error(`market ${relativePath}: empty response body`);
      alive();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          alive();
          received += value.byteLength;
          if (options && received > options.expectedBytes) {
            throw new Error(`Bundle size mismatch: expected ${options.expectedBytes} bytes, got more than that`);
          }
          chunks.push(value);
          options?.onProgress?.(received);
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}
