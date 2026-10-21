import { createContext } from 'react';

/**
 * #6264 浏览器页签加载一个网址之前,给宿主一次改写它的机会 —— 别的机器上的会话里,
 * `http://localhost:3000` 指的是**那台机器**上的 3000 端口:宿主先经 SSH 把一个本机端口转过去,
 * 再让页签加载转好的那个地址(照 VS Code 的端口转发)。本机会话没有这个宿主,网址原样加载。
 *
 * 失败时给一句给人看的话(已经按界面语言写好),页签把它画成加载失败页,❌ 加载一个连不上的地址。
 */
export type BrowserUrlResolution = { url: string } | { error: string };

export type BrowserUrlResolver = (url: string, browserId: string) => Promise<BrowserUrlResolution>;

export const BrowserUrlResolverContext = createContext<BrowserUrlResolver | null>(null);
