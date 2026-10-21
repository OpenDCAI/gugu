// #6264 别的机器上的会话里点链接(终端、聊天记录):`http://localhost:5173` 指的是**那台机器**上的服务,
// 要开进这条会话的浏览器格(经 SSH 转端口),❌ 开到这台电脑自己的 5173(照 VS Code 远端终端链接 + 自动转发、Zed #36130)。
// 这里只是一个口:此刻在看的是别的机器上的会话时,remote-hosts 那边给出怎么开(lib ❌ 反向依赖 features)。
export type RemoteLinkTarget = {
  /** 这条会话有浏览器格(只有用 SSH 装上的机器有)。 */
  canOpenInBrowserTab: boolean;
  openInBrowserTab(url: string): void;
  /** 是那台机器的 localhost 就接过去(开进浏览器格,或如实说开不了)并返回 true;别的网址返回 false。 */
  claimLoopback(url: string): boolean;
};

let provider: (() => RemoteLinkTarget | null) | null = null;

export function setRemoteLinkTargetProvider(next: (() => RemoteLinkTarget | null) | null): void {
  provider = next;
}

/** 此刻在看的是别的机器上的一条会话 ⇒ 它的开法;否则 null。 */
export function activeRemoteLinkTarget(): RemoteLinkTarget | null {
  return provider?.() ?? null;
}
