// #6264 发现别的机器上新起的服务:照 VS Code `remote.autoForwardPortsSource: "output"`(SSH 的默认)——
// 扫终端 / agent 输出里的 `localhost:3000`、`http://127.0.0.1:8000`、`0.0.0.0:5173`、Python 的
// `Serving HTTP on 0.0.0.0 port 8000`(VS Code urlFinder.ts 的同几条)。
// 纯计算,主进程(直连终端的输出)与渲染层(聊天记录)共用。事件驱动:每来一段输出扫一次,❌ 定时去问那台机器。
//
// ⚠️ 这个文件要能进浏览器与主进程两边:❌ import 任何带 node / electron 依赖的模块。

// 终端颜色码 / 光标移动 / OSC(ESC ] … BEL|ST)。
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// 端口号后面紧跟省略号(`localhost:87…`)= 被截断的输出(聊天记录里过长的工具输出会截),不是真端口。
const LOOPBACK_PORT = /(?:^|[^\w.-])(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))(?![\d]|…|\.\.\.)/gi;
const PYTHON_SERVER = /Serving HTTP on (?:127\.0\.0\.1|0\.0\.0\.0|::|\[::\]) port (\d{2,5})/gi;

/**
 * 这一段文字里提到的那台机器自己的端口(去重、按出现先后)。
 * `complete = false`:这段文字后面还会接着来(输出流的一段)—— 贴着末尾的那个端口号可能还没写完
 * (`localhost:87` + 下一段的 `65`),先不报,等下一段拼上再说(2026-09-24 d22 端口表里冒出一行「87」)。
 */
export function findLoopbackPorts(text: string, complete = true): number[] {
  const clean = text.replace(ANSI, '');
  const found: number[] = [];
  for (const pattern of [LOOPBACK_PORT, PYTHON_SERVER]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(clean); match; match = pattern.exec(clean)) {
      if (!complete && match.index + match[0].length >= clean.length) continue;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536 && !found.includes(port)) found.push(port);
    }
  }
  return found;
}

/** 输出是一段一段来的:留上一段的尾巴(地址可能被切成两半),只报这条流里第一次出现的端口。 */
export function createPortDetector(options: { tailChars?: number; maxPorts?: number } = {}) {
  const tailChars = options.tailChars ?? 256;
  const maxPorts = options.maxPorts ?? 64;
  const seen = new Set<number>();
  let tail = '';
  return {
    push(chunk: string): number[] {
      const text = tail + chunk;
      tail = text.slice(-tailChars);
      if (seen.size >= maxPorts) return [];
      const fresh = findLoopbackPorts(text, false).filter((port) => !seen.has(port));
      for (const port of fresh) seen.add(port);
      return fresh;
    },
  };
}
