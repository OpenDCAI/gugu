/**
 * 「谁起的」——一条会话由扩展发起时,行上挂的那句话。
 *
 * behavior tab-extensions「agent 的可见与可控」:扩展起的会话在会话图上要能表示
 *「由这个扩展发起」;卸载之后**标记留存**,显示为「由已卸载的扩展 X 发起」——
 * 用户没关的东西不能自己没,而「那个已经卸载的扩展」比沉默是更好的答案。
 *
 * 文案走词表。**这一段原来写的是「与所在那一行一致,中文硬编码,整行的本地化是另一件事」**——
 * 那个理由在 2026-09-05 失效了:整行(`sidebar-session-item` 及其邻居)已经接上词表,
 * 于是"一致"的方向反过来了。owner 当时报的正是这个后果:英文壳里混着中文。
 *
 * 单独抽成一个纯函数,是因为这里唯一会出错的地方不是画法,是**判据**:
 * 「查不到清单」有两种成因——真卸载了,和清单还没加载完。把后者读成前者,
 * 会让每条这样的会话在启动后的头几百毫秒里都自称「已卸载」,而那是句谎话。
 * 失败仪器的空输出不是阴性读数。
 */
import { translateSessionMessage } from '@renderer/localization/locale-store';
export function spawnedByExtensionLabel(options: {
  extensionId: string | null | undefined;
  /** 装着的那个扩展的显示名;查不到为 undefined。 */
  installedName: string | undefined;
  /** 扩展清单是否已经读出来了。没读出来时,查不到不构成「已卸载」。 */
  manifestsLoaded: boolean;
}): string | null {
  const id = options.extensionId?.trim();
  if (!id) return null;
  if (options.installedName)
    return translateSessionMessage('extensions.spawnedBy', { name: options.installedName });
  // ❌ 清单没加载完时别说「已卸载」:那时候什么都查不到,连装着的也查不到。
  if (!options.manifestsLoaded) return translateSessionMessage('extensions.spawnedBy', { name: id });
  return translateSessionMessage('extensions.spawnedByUninstalled', { name: id });
}
