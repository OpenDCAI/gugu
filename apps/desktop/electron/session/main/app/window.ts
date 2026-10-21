/**
 * 会话页与主 app 共用 IPC 桥登记的真实主窗口。
 * Electron 的窗口枚举没有创建顺序保证,隐藏的 App 后台窗也在其中;不能取列表第一项。
 */
export { getMainWindow } from '../../../ipc-bridge';
