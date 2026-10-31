import type { Plugin } from 'vite'

// @@@6340 每个 Monaco 语言 worker 只打一次包。
// monaco-editor 0.55 的四个 vs/language/<lang>/workerManager.js 自带兜底
// `createWorker: () => new Worker(new URL('<lang>.worker.js', import.meta.url), …)`;
// 会话页的 monaco-bootstrap.ts 又以 `…/<lang>.worker?worker` 引同一个文件(MonacoEnvironment.getWorker 在前,
// 兜底从不被走到)。vite 按「模块 id」缓存 worker 包,两条引用的 id 不同(一个带 ?worker),且两次打包
// 在同一时刻起跑、谁也等不到谁的缓存 ⇒ css/html/json/ts 四个 worker 各打两遍,产出逐字相同的资源,
// 白占渲染层构建主线程(mac1 实测 ~8s,ts.worker 内含 7MB 的 typescriptServices)。
// 这里把兜底改成 import 同一个 `?worker` 模块:rollup 每个 id 只加载一次 ⇒ 每个 worker 只打一次包;
// 兜底行为不变(同一份 worker 资源、同样 type:module)。
// 形状对不上就在构建结束时响亮失败 —— monaco 升级改了这行,❌ 静默退回双份打包。
const WORKER_MANAGER_RE = /\/monaco-editor\/esm\/vs\/language\/(css|html|json|typescript)\/workerManager\.js$/
const FALLBACK_RE = /new Worker\(new URL\('(\w+)\.worker\.js', import\.meta\.url\), \{ type: "module" \}\)/g
const EXPECTED_LANGUAGES = ['css', 'html', 'json', 'typescript']

export function rewriteMonacoWorkerFallback(code: string): { code: string; rewrites: number } {
  const workers = new Set<string>()
  const rewritten = code.replace(FALLBACK_RE, (_, worker: string) => {
    workers.add(worker)
    return `new __guguMonacoWorker_${worker}()`
  })
  const imports = [...workers].map((w) => `import __guguMonacoWorker_${w} from './${w}.worker.js?worker';\n`)
  return { code: imports.join('') + rewritten, rewrites: workers.size }
}

export function monacoWorkerSingleBundlePlugin(): Plugin {
  const rewritten = new Set<string>()
  return {
    name: 'gugu-monaco-worker-single-bundle',
    // 只有 build 会把 worker 打成独立包;dev 服务关闭时也会调 buildEnd,那里没有「必须改到四处」可言。
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const match = WORKER_MANAGER_RE.exec(id)
      if (!match) return null
      const result = rewriteMonacoWorkerFallback(code)
      if (result.rewrites !== 1) {
        this.error(`expected exactly 1 worker fallback in ${id}, found ${result.rewrites}`)
      }
      rewritten.add(match[1])
      return { code: result.code, map: null }
    },
    buildEnd(error) {
      // 渲染层构建必含 Monaco(会话页编辑器),一个都没改到 = 路径形状变了,同样判红。
      if (error) return
      const missing = EXPECTED_LANGUAGES.filter((lang) => !rewritten.has(lang))
      if (missing.length > 0) {
        this.error(`monaco workerManager not rewritten for: ${missing.join(', ')}`)
      }
    },
  }
}
