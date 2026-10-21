// @@@renderer-cmd-protocol — main→renderer 命令协议。对外 JSON-RPC automation 面删除后，
// chat/contacts/settings/ui 这几条腿（曾只服务 HTTP RPC delegation）已无调用者；只剩 auth 腿
// 仍活(主进程开机时经 invokeRendererAuth 问 getSessionOwner;令牌本身由渲染进程推给主进程，不经这条腿)。
//
// `extensions` 是第二条活腿:扩展桥在主进程里判权限(身份只能从 session 取),但改 tab 标题、
// 打 badge、开浏览器 tab、把选中内容投进对话,都发生在渲染层。复用这条既有通道,而不是给扩展
// 另开一套 main→renderer 推送 —— 两套并存必然漂,而且第二套不会有人记得维护。
export type RendererCommandDomain = 'auth' | 'extensions'

export const RENDERER_COMMAND_DOMAINS: RendererCommandDomain[] = ['auth', 'extensions']

export function rendererCommandChannel(domain: RendererCommandDomain): string {
  return `${domain}:cmd`
}

export function rendererCommandResultChannel(domain: RendererCommandDomain): string {
  return `${rendererCommandChannel(domain)}:result`
}

export function rendererCommandReadyChannel(domain: RendererCommandDomain): string {
  return `${rendererCommandChannel(domain)}:ready`
}

export function rendererCommandEventName(domain: RendererCommandDomain): string {
  return `__${domain}_cmd`
}
