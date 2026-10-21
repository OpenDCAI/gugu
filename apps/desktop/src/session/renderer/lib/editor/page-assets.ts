// 纯判定,与渲染无关:HTML 预览(文件页签)与 file: 网页(浏览器页签)共用。放在组件文件外面,
// 免得只要这一个函数的地方把整个预览组件的依赖图一起拖进来。

/** 页面引用得到、改了该重载的那几类文件。 */
const PAGE_ASSET = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|md|mdx|csv)$/i;

/**
 * 页面所在目录(或它底下)的样式 / 脚本 / 图片这类文件变了 —— 页面引用的可能就是它,重载一次。
 * `includePage`:页面自己变了也算(浏览器页签里开着的那一页;文件页签的预览看的是缓冲区,不算)。
 */
export function touchesPageAssets(pagePath: string, changedPaths: readonly string[], includePage = false): boolean {
  const norm = (path: string) => path.replace(/\\/g, '/');
  const page = norm(pagePath);
  const dir = page.slice(0, page.lastIndexOf('/') + 1);
  return changedPaths.some((changed) => {
    const path = norm(changed);
    if (path === page) return includePage;
    return dir !== '' && path.startsWith(dir) && PAGE_ASSET.test(path);
  });
}
