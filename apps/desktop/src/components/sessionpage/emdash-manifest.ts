// 从会话页那个入口的构建产物(dist/session-embedded.html)里解出 host 要加载的资源引用。
//
// ⚠️ stylesheet 必须取**全部**、且保持文档序。vite 按 chunk 切 CSS,这个入口实测 emit 两张表:
//   <link rel="stylesheet" href="./assets/session-*.css">     ~0.5MB  会话页主体
//   <link rel="stylesheet" href="./assets/vendor-*.css">           与咕咕共用的第三方样式
// host 此前用 querySelector 只取第一张 → 第二张从未进过 shadow root。而会话页
// embedded.tsx 里那句 `import 'sonner/dist/styles.css'` 的注释写明它就是为了「让 sonner 的 CSS
// 落进 host 会注进 shadow root 的构建 CSS」——取一张的写法让这个修复静默失效,会话页的 toast
// 一直渲染成裸 <ol>。❌ 不要退回 querySelector:表的张数由 vite 的 chunk 切分决定,不是契约。
export interface EmdashManifestRefs {
  /** 全部带 src 的 module script。Vite dev 会在应用入口之前注入 /@vite/client。 */
  moduleScripts: string[]
  /** 全部 stylesheet 的 href,文档序即层叠序。 */
  stylesheets: string[]
}

export type EmdashManifestTransport = 'vite-dev' | 'built'

export interface RequiredEmdashManifestRefs {
  script: string
  stylesheets: string[]
}

export function parseEmdashManifest(html: string): EmdashManifestRefs {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return {
    moduleScripts: Array.from(doc.querySelectorAll('script[type=module][src]'))
      .map((script) => script.getAttribute('src'))
      .filter((src): src is string => Boolean(src)),
    stylesheets: Array.from(doc.querySelectorAll('link[rel=stylesheet]'))
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => Boolean(href)),
  }
}

export function requireEmdashManifestAssets(
  refs: EmdashManifestRefs,
  transport: EmdashManifestTransport,
): RequiredEmdashManifestRefs {
  const applicationScripts = transport === 'vite-dev'
    ? refs.moduleScripts.filter((src) => new URL(src, 'http://vite.invalid').pathname !== '/@vite/client')
    : refs.moduleScripts
  if (applicationScripts.length !== 1) {
    throw new Error(
      `embedded ${transport} manifest must contain exactly one application module script ` +
      `(found ${applicationScripts.length})`,
    )
  }
  if (transport === 'built' && refs.stylesheets.length === 0) {
    throw new Error('embedded built manifest is missing renderer stylesheets')
  }
  return { script: applicationScripts[0], stylesheets: refs.stylesheets }
}
