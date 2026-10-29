import type { CdpHub } from './cdp-hub';

/** 站点 = 协议 + 主机(+ 非默认端口);❌ 带路径:登录请求只显示当前站点。 */
export function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** 页签里每个同进程框架的 document(在隔离环境里拿,页面自己的脚本看不见);跨进程的框架(另一个 target)够不着,跳过。 */
async function* frameDocuments(hub: CdpHub, sessionId: string): AsyncGenerator<string> {
  await hub.send('Page.enable', {}, sessionId);
  const { frameTree } = await hub.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId);
  const frames: string[] = [];
  const walk = (node: FrameTree) => {
    frames.push(node.frame.id);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  for (const frameId of frames) {
    let contextId: number;
    try {
      ({ executionContextId: contextId } = await hub.send<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId, worldName: 'gugu-browser-redaction', grantUniveralAccess: false },
        sessionId
      ));
    } catch {
      continue;
    }
    const { result: documentRef } = await hub.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document', contextId }, sessionId);
    if (documentRef.objectId) yield documentRef.objectId;
  }
}

/**
 * 页面上所有密码框里现在的值。人接管时自己敲的密码 / 验证码:交还前读出来登记进脱敏名单 ——
 * agent 之后的页面快照会把密码框的值原样写出来。
 */
export async function readPasswordValues(hub: CdpHub, sessionId: string): Promise<string[]> {
  const values: string[] = [];
  for await (const objectId of frameDocuments(hub, sessionId)) {
    const { result } = await hub.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: "function () { return [...this.querySelectorAll('input[type=password]')].map((el) => el.value).filter(Boolean); }",
        returnByValue: true,
      },
      sessionId
    );
    if (Array.isArray(result.value)) for (const value of result.value) if (typeof value === 'string') values.push(value);
  }
  return values;
}

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
