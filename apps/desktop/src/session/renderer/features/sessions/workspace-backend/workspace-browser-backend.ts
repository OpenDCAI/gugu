// 浏览器页签背后按机器不同的那一半(界面只有一个:browser-tab-provider + BrowserPane)。
// 这台电脑:网址原样加载。别的机器(照 VS Code 端口转发 https://code.visualstudio.com/docs/remote/ssh#_forwarding-a-port-creating-ssh-tunnel):
// `localhost:N` 指那台机器上的 N 端口 —— 先经 SSH 转过来再加载;`file:` 指那台机器上会话目录里的网页 —— 经 `gugu-preview://`
// 从那台机器取来渲染;ssh 要问人时,问题画成浏览器上方的提问卡片。
import type { SshPrompt } from '@shared/ssh-prompt';
import type { BrowserUrlResolver } from '@renderer/features/browser/browser-url-resolver';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';

/** 挂在一个浏览器页签上的、按机器不同的那部分(页签关掉时 dispose)。 */
export interface WorkspaceBrowserAttachment {
  /** 加载前改写网址(转发端口 / 登记预览);失败给一句人话,页签画成加载失败页。 */
  readonly resolve: BrowserUrlResolver;
  /** ssh 此刻等人回答的问题(可观察)+ 卡片第一行(哪台机器、在做什么);没有 = null。 */
  readonly prompt: { context: { name: string; detail?: string | null }; prompt: SshPrompt } | null;
  /** installKey:密码提问上勾了「以后连这台机器不用再输密码」(#6264「下次免密」)。 */
  answer(value: string | null, extra?: { installKey?: boolean }): void;
  dispose(): void;
}

export interface WorkspaceBrowserBackend {
  /** 这台机器上的会话有没有浏览器格(只经云端连着的机器没有:网页流量 ❌ 塞进云端消息通道)。 */
  readonly available: boolean;
  /** 页签能不能从上次的快照复活(转发的端口活不过应用重启)。 */
  readonly persistent: boolean;
  /** 给一个浏览器页签装上这台机器的那一半;这台电脑 = null(原样加载)。 */
  attach(browserId: string, ctx: SessionTabContext): WorkspaceBrowserAttachment | null;
}
