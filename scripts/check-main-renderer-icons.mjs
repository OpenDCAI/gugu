#!/usr/bin/env node
// 咕咕的图标一律走 `@/lib/icons`(Solar),❌ 不直连 lucide-react —— 除下面这份具名清单。
//
// owner 2026-08-12 裁决:图标统一到 Solar。唯一的例外是 Solar 集合里**真的没有**的那几族;
// 判据不是「不好看」而是「搜不到」,每一条下面都写了实测结论。
//
// 为什么允许清单要写死在闸里,而不是「会话页整个目录豁免」:目录豁免等于放弃统一 ——
// 下一个人在会话页随手 import 任何 lucide 图标都合法。写死名字才让例外**不扩散**,
// 而且新增一个例外必须改这个文件、走一次评审。
//
// 为什么**不**做成 eslint override:.eslintrc.cjs 里已经有两条同名 no-restricted-imports
// (base 那条拦 radix、@typescript-eslint 那条拦 session-core/acp)。overrides 里同名规则是
// **替换不是合并**,再加一条会把先写的整条顶掉且不报错 —— 那条坑就写在 .eslintrc.cjs:94。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 两处都扫:图标真身在 packages/session-ui/src/icons.tsx,apps/desktop/src/lib/icons.tsx
// 只是转发出口。只扫 app 侧的话,session-ui 里退回 lucide 不会被发现。
const SCAN_ROOTS = ['apps/desktop/src', 'packages/session-ui/src'].map((p) => path.join(repoRoot, p))

// Solar 里搜不到对应字形的,只能留 lucide。改这份清单 = 扩大例外,请在 PR 里说明实测依据。
export const LUCIDE_ALLOWLIST = new Set([
  // git / VCS / 品牌:Solar 搜 `git*` / `merge` / `pull-request` / `github` 全部零命中。
  // PR 的 open/closed/draft/merged 是用户必须一眼分清的四态,拿语义无关的图形凑会真损可用性。
  'GitBranch', 'GitFork', 'GitMerge', 'GitPullRequest', 'GitPullRequestArrow',
  'GitPullRequestClosed', 'GitPullRequestDraft', 'FolderGit2', 'Github', 'GithubIcon',
  // 方向性面板开关:Solar 搜 `panel` 零命中,只有 sidebar / sidebar-minimalistic / sidebar-code
  // 三个,没有左/右/下之分。硬凑会让四个开关长得一样,用户分不出开的是哪个面板。
  // Close/Open 那两对是**同一族的状态形**:面板开关的图标要随状态换形,一眼读出这一下是收起
  // 还是展开(见 shell-titlebar.tsx / session-titlebar.tsx)。Solar 同样没有,理由同上。
  'PanelLeft', 'PanelRight', 'PanelBottom', 'Columns2',
  'PanelLeftClose', 'PanelLeftOpen', 'PanelRightClose', 'PanelRightOpen',
  // 拖拽手柄:Solar 搜 `drag` 零命中;凑成 menu-dots 会把手柄变成菜单按钮。
  'GripVertical',
  // Shift 键那个粗箭头:Solar 无 bold/filled 的方向箭头,凑成细箭头就丢了「这是修饰键」。
  'ArrowBigUp',
  // 裸减号:Solar 只有 minus-circle / minus-square,没有裸的。
  'Minus',
  // assistant-ui registry MCP server panel is intentionally copied verbatim;
  // its ChevronRightIcon and PlugIcon imports are part of the upstream bytes.
  'ChevronRightIcon', 'PlugIcon'
])

// 只认真正的 import/require,不认注释里提到的名字 —— icons.tsx 的文件头就写着
// 「drop-in 替代 lucide-react」,整串 grep 会把那句注释当成违规(#2794 同一个病)。
// 静态与动态分两条:动态 import() 出现在表达式中间(`await import(...)`),套不进
// 「行首 import」那条 —— 合成一条时它就漏了,是单测抓出来的。
const STATIC_IMPORT = /(?:^|\n)[ \t]*(?:import|export)\b[\s\S]{0,400}?\bfrom[ \t]*['"]lucide-react['"]/
const DYNAMIC_IMPORT = /\b(?:require|import)\s*\(\s*['"]lucide-react['"]\s*\)/
const NAMED_IMPORT = /(?:^|\n)[ \t]*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g

/** 这个文件从 lucide 引进来的、**不在**允许清单里的名字。空数组 = 合规。 */
export function offendingSpecifiers(source) {
  if (DYNAMIC_IMPORT.test(source)) return ['<dynamic import>']
  if (!STATIC_IMPORT.test(source)) return []
  const bad = []
  let matched = false
  NAMED_IMPORT.lastIndex = 0
  for (const m of source.matchAll(NAMED_IMPORT)) {
    matched = true
    for (const spec of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = spec.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (!LUCIDE_ALLOWLIST.has(name)) bad.push(name)
    }
  }
  // 有 lucide import 但不是具名形式(默认导入 / import * as):看不懂就当违规。
  // ❌ 别放行 —— 放行等于给「换个写法就能绕过」开门。
  if (!matched) return ['<non-named lucide import>']
  return bad
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

export function findViolations(files, read = (f) => fs.readFileSync(f, 'utf8')) {
  const out = []
  for (const file of files) {
    const bad = offendingSpecifiers(read(file))
    if (bad.length) out.push({ file, names: [...new Set(bad)] })
  }
  return out
}

const files = SCAN_ROOTS.flatMap((root) => walk(root))
const violations = findViolations(files)

if (violations.length > 0) {
  console.error(`\n❌ ${violations.length} 个文件直连 lucide-react 且不在允许清单里,应改用 '@/lib/icons'(Solar):`)
  for (const v of violations) {
    console.error(`   ${path.relative(repoRoot, v.file)}  —  ${v.names.join(', ')}`)
  }
  console.error(
    '\n要的图标不在 @/lib/icons 里 → 在 scripts/icons/solar-icons.json 的 "solar" 栏加一行,' +
    '\n再跑 `node scripts/gen-icons.mjs`。❌ 别手写 path、❌ 别直接改生成物。' +
    '\nSolar 里确实没有(先实测搜一遍) → 加进本文件的 LUCIDE_ALLOWLIST 并写明实测依据。'
  )
  process.exit(1)
}

const allow = LUCIDE_ALLOWLIST.size
console.log(`icon guard passed: ${files.length} files scanned, lucide 仅限 ${allow} 个具名例外`)
