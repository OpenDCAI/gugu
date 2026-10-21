// @@@2633 —— 让 `node` project 里「import 期就打开数据库」的模块能起来。
//
// 症状:session-provider-respawn.test.ts 在**收集期**就崩,不是断言失败:
//   set-session-id.ts → db/client.ts 顶层 `new Database(resolveDatabasePath())`
//   → db/path.ts 的 `app.getPath('userData')`,而这里没有 electron 运行时,`app` 是 undefined。
//
// 为什么用 GUGU_SESSION_DB_FILE 而不是 mock electron:
//   resolveDatabasePath 自己**第一步**就查这个环境变量,命中即 return、根本不碰 `app`。
//   它是产品自带的隔离库开关(AGENTS.md 里就是这么教人跑隔离库的),不是为测试新开的后门。
//   mock electron 要拦一整个模块,影响面比这大得多。
//
// ❌ 不用固定路径:vitest 并行跑多个 worker,共用一个 sqlite 文件会让它们互相踩。
//    每个测试文件起一次 setup,各拿各的路径。
// ❌ 不覆盖已经自己设了该变量的测试(如 ssh-connection-manager.test.ts)——这里只兜底。
//
// 文件本身是懒创建的:只有真的 `new Database(path)` 才会落盘,大多数测试根本不碰。
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { installJsdomCanvasStub } from '../../../tests/support/jsdom-canvas-stub';

// 这个 project 的默认环境是 node，但单个文件可以用 `// @vitest-environment jsdom` pragma 换到 DOM
// （acp-chat-store.session-absent.test.ts 就是），而 jsdom 没有 canvas 2D 上下文 ——
// import 链一旦走到加载动效组件，lottie 在模块加载期就抛，整个文件起不来。
// 装这一格前它在 CI 上红过一次：`Test Files 1 failed | 625 passed`，`Tests` 一条都没红。
// 函数自己判 `typeof window`，所以纯 node 的文件走到这里是 no-op。
installJsdomCanvasStub();

// 同一条 import 链上的第二件事:真 lottie 播放器模块顶层排了一条关不掉的轮询,会活过 jsdom
// 拆除再把无关的 job 判红(#5237)。安装点和上面那格是同一批 —— `gugu` 与 `session-main` 两份
// setup 都要装,只补一份的结果就是另一份照旧留残留。机制与出口见替身模块的抬头。
vi.mock('lottie-web/build/player/lottie_light', async () => ({
  default: (await import('../../../tests/support/lottie-player-stub')).lottiePlayerStub,
}));

// ⚠️ 这个安装点是**量出来的**,不是防御性的:把上面那个工厂改成抛,
// `acp-chat-store.session-absent.test.ts` 当场炸 ⇒ 这条 import 链真的走到 lottie。
// 而「桩在这个 project 里生效了」是借**产品自己的失败模式**验的(把上面那格 canvas 桩关掉:
// 装着 mock → 22 passed;去掉 mock → 文件起不来,`Cannot set properties of null (setting 'fillStyle')`)。
// ⚠️ 那条探测器读的是「真播放器**有没有被加载**」;它等于「没有残留定时器」,靠的是
// 「那条 setInterval 排在**模块顶层**」这条事实。
// ⇒ 那条事实变了的话,这里的验法也得重新设计,❌ 不是删个桩就完了。

// @@@test-electron-window - Main-process operations run without Electron in node tests.
// Keep the window boundary explicit here so every operation can broadcast through the real
// event adapter while tests that care about delivery can replace it with windows.
vi.mock('electron', async (importOriginal) => {
  const electron = await importOriginal<typeof import('electron')>();
  return {
    ...electron,
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
  };
});

// @@@task-web-host — 宿主的 IPC 现在从 HostIpc 拿(lib/host-ipc.ts),不再直连 electron。boot 时才
// setHostIpc;node 测试里没有 boot,这里装一份与上面那个 BrowserWindow 桩同义的宿主:广播投给
// getAllWindows() 返回的窗口(默认零个),请求/应答无人注册。测试要观察投递,照旧替换 getAllWindows。
import { BrowserWindow } from 'electron';
import { setHostIpc } from '../electron/session/main/lib/host-ipc';

setHostIpc({
  ipcMain: {
    handle: () => {},
    removeHandler: () => {},
    on: () => {},
    removeListener: () => {},
  },
  broadcast: (channel, data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, data);
    }
  },
  createMessageChannel: () => {
    throw new Error('[vitest-node-setup] node 测试没有 wire 端口:要测端口请在用例里 setHostIpc');
  },
});

if (!process.env.GUGU_SESSION_DB_FILE?.trim()) {
  const dir = join(tmpdir(), 'gugu-vitest-node');
  mkdirSync(dir, { recursive: true });
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  process.env.GUGU_SESSION_DB_FILE = join(dir, `${unique}.db`);
}
