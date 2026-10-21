/**
 * 把会话页的入口 module 载进来:兑现 = 整张模块图求值完了(顶层 await 等宏任务也算在内);被拒 = 起不来 —— 取文件失败、解析错、
 * 求值时抛错、顶层 await 被拒都是，拒绝原因就是那个真实的错误。单独一个模块，测试才换得掉这次 import。
 */
export function importSessionEntry(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}
