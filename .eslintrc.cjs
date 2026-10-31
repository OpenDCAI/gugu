const buttonStyleDebt = require('./scripts/button-style-debt-baseline.json')

// @@@spawnsync-input (#3766) —— 这段是这条缺陷在本仓的**唯一**完整说明,别处只留一行指回这里。
//
// 同步 spawn 的 `input` 是往子进程 stdin 灌字节,而 spawnSync 送文件结束信号靠的是排在写请求
// 后面的 uv_shutdown。macOS 上那一步会间歇性永不落地:子进程堵在空管道的 read(2) 上,一直到
// spawn 的 timeout 才解开 —— 没设 timeout 就是干等到整个 job 超时。
//
// 两组实测(mac1,同机同负载,分组交替以排除负载漂移):
//   ① 同步 vs 异步,payload 都是 256KiB —— execFileSync({input}) 挂死 7/6000,spawn 0/6000
//   ② 只变 payload 尺寸 —— 256KiB 挂死 16/6000,16KiB 与 1KiB 各 0/6000
// 两组的 256KiB 数字不同是因为它们是两次独立的实验,不是同一个数被抄歪了。②的第一次跑
// **对照组也是空的**(256KiB 也 0),那轮读数按「对照空则读数作废」丢掉重来了 —— 原因是把命令
// 简化成了裸 `cat > /dev/null`,得用原样的 hook 命令才复现得出来。
// ⇒ 犯不犯绑在「payload 超过管道缓冲」上(超了才会写一半、EOF 才需要排在残余写请求后面),
//   而 payload 会长,所以按尺寸豁免不是办法,写法本身要没。
//
// 替代写法按场景选:能用参数传的就用参数(`git commit-tree -m`);要真 stdin 的从文件喂
// (`stdio: [openSync(f,'r'), …]`,根本不开管道);空 stdin 用 `stdio: ['ignore', …]`;
// 断言本身就是「写方有没有被 EPIPE 打断」的才需要管道,那种改异步 spawn(见 posix-hook-guard)。
//
// 单独提成常量是因为 no-restricted-syntax 在 override 里是**整条替换**不是合并 —— 只写在顶层
// rules 里,下面那条 .tsx 的 override 会把它整个盖掉,留出一块没人管的地方。
// 四种写法都要拦,少一种这道闸就等于没装:
//   execFileSync(…, { input })      裸调用
//   cp.execFileSync(…, { input })   成员调用(callee.name 是 undefined,只匹配 callee.name 会漏)
//   execFileSync(…, { 'input': … }) 字符串键(key.name 是 undefined,要看 key.value)
// ⚠️ 第四种拦不住,也别假装拦得住:`const o = { input: x }; execFileSync(…, o)` —— 选项对象
// 一旦经过变量,AST 选择器就无从判断。语法选择器的能力边界在这儿,不是没想到。
const noSyncSpawnInput = {
  selector:
    "CallExpression:matches([callee.name=/^(execFileSync|spawnSync|execSync)$/],[callee.property.name=/^(execFileSync|spawnSync|execSync)$/])"
    + " > ObjectExpression > Property:matches([key.name='input'],[key.value='input'])",
  message:
    "同步 spawn 的 `input` 在 macOS 上会间歇性挂死到超时(#3766，详见 .eslintrc.cjs 顶部 @@@spawnsync-input)。改成:参数传值 / 从文件喂 stdin(stdio:[fd,…]) / 空 stdin 用 stdio:['ignore',…] / 需要管道语义的改异步 spawn。"
}

module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended'
  ],
  // skill 捆绑的 examples/scripts 是**文档产物**,不是产品源码:它们从上游 vendored 进来,存在的意义
  // 是被人读、被照着抄,不参与构建、不被任何产品代码 import。把咕咕的规则套上去只有两个出路——
  // 要么为了过 lint 去改上游示例(等于篡改文档),要么长期挂着 error。两个都不对,所以整体排除。
  // 注意 lint 命令带 --max-warnings 0,warning 一样会红,不排除的话连「未使用的 useState 演示」都拦门。
  ignorePatterns: [
    'apps/desktop/src/**/*.js',
    'apps/mobile/android',
    'dist',
    'dist-phone',
    'dist-electron',
    'out',
    'release',
    'playwright-report',
    'test-results',
    // @@@storybook-gate (#3526) — storybook build 的产物。它是编译输出而不是源码,lint 带
    // --max-warnings 0,不排除的话本地跑过一次 storybook build 就有 35 个产物文件把整道门刷红,
    // 而真实源码里一条问题都没有 —— 那样的红读起来像「这次改动破坏了 lint」。
    'storybook-static',
    'storybook-static-chat',
    '.eslintrc.cjs',
    // #7191 agent 鼠标的轨迹与画法:trycua/cua 的 @trycua/cursor-motion(MIT,不发 npm,官方用法就是拷 src/),原样拷进来;
    // 上游改了重拷一遍,所以不按咕咕的规矩改它。出处与版本见该目录 README.md。
    'apps/desktop/src/session/renderer/lib/vendor/cua-cursor-motion/**',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  overrides: [
    {
      files: ['*.cjs', 'scripts/**/*.cjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off'
      }
    },
    {
      // assistant-ui 官方 registry 的源码,原样拷进来的(#5013 手机看管页整份用它的 Thread)。
      // 拷贝就是这套 registry 的用法 —— 上游改了要能重新拷一遍再合,所以刻意贴着它的原貌。
      files: ['apps/desktop/src/components/assistant-ui/**/*.{ts,tsx}'],
      rules: {
        // 纯 HMR 开发体验规则。官方那几个文件按它自己的组织方式在同一个文件里同时导出组件与
        // 常量/类型。要「修」就得把它的结构拆散重排,换不来任何运行时收益,而且**每次跟上游
        // 同步都会再冒出来** —— 与上面 task-fusion 那条同一个理由、同一个处置。
        'react-refresh/only-export-components': 'off',
        // Registry bytes are kept verbatim. Do not force an upstream hook
        // dependency rewrite that would make the copied source diverge.
        'react-hooks/exhaustive-deps': 'off'
      }
    },
    {
      // @@@task-fusion (#2802) — 会话页代码也进这道 lint 门。它原先用的是
      // oxlint、规则集不同,直接套咕咕的规则报了 400 多条。下面每一条关闭都写明理由,**不是**图省事
      // 一把关掉:凡是能机械改且改了不变行为的(while(true)、穿透注释、失效 disable、prefer-const、
      // @ts-ignore)都已逐条改掉,留在这里的是「改了会动行为」或「本来就是这份代码的正当写法」。
      files: [
        'packages/session-*/**/*.{ts,tsx}',
        'apps/desktop/src/session/**/*.{ts,tsx}',
        'apps/desktop/electron/session/**/*.{ts,tsx}',
        'apps/desktop/session-tooling/**/*.{ts,tsx}'
      ],
      rules: {
        // 纯 HMR 开发体验规则。会话页的 UI kit 按设计在同一个 barrel 里同时导出组件、hook、类型
        // 与常量(201 处命中),要「修」就得把这套公开 API 拆散重排 —— 改的是结构,换不来任何
        // 运行时收益,而且每次跟上游同步都会再冒出来。
        'react-refresh/only-export-components': 'off',
        // 69 处全是空的 catch,是「这里就是要忽略」的既有写法。eslint 自带这个开关,专为此设。
        'no-empty': ['error', { allowEmptyCatch: true }],
        // 会话页要解析 ANSI/终端控制序列(pty、xterm、diff 着色),正则里出现控制字符是本分。
        'no-control-regex': 'off',
        // 50 处 any。要「修」等于替没写过这些代码的人凭空补类型,补错了就是拿一个不健全的断言换
        // 绿灯 —— 比留着 any 更坏。留待后续按模块真正收敛。
        '@typescript-eslint/no-explicit-any': 'off',
        // 改依赖数组会改运行时行为(多跑一次 effect、少订阅一次),不是能盲改的东西;
        // 20 处命中里已有若干带 disable 注释说明过理由。
        'react-hooks/exhaustive-deps': 'off',
        // 命中的 6 处是 `(string & {})`(保留字面量补全的惯用法)与 `= {}` 的默认类型参数,
        // 都是正当写法;这条规则在 typescript-eslint v8 里本身也已拆分废弃。
        '@typescript-eslint/ban-types': 'off'
      }
    },
    {
      // task renderer 与它的 shared DTO 图不能从 ACP 根 barrel 带入 Node-only transport。
      // Type-only import 会在编译期擦除，仍允许用根出口共享类型。
      // #6264:session-record 根出口同样带 Node-only 的记录源(fs / sqlite);值导入走 /contract。
      // 范围扩到整个 apps/desktop/src(都是渲染进程),漏过一次就是整页白屏。
      files: ['apps/desktop/src/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@gugu/session-core/acp',
                allowTypeImports: true,
                message: 'Renderer value imports must use @gugu/session-core/acp/client.'
              },
              {
                name: '@gugu/session-core/session-record',
                allowTypeImports: true,
                message: '渲染进程的值导入走 @gugu/session-core/session-record/contract:根出口带 Node-only 的记录源,会让整页白屏(#6264)。'
              }
            ]
          }
        ]
      }
    },
    {
      // #3334 — `radix-ui` 的有界例外闸门。
      //
      // assistant-ui 的 registry 组件**可能**依赖 radix，而 design-system spec 的不变量是「组件模板
      // 只有一套」(本仓用 Base UI)。owner 裁决是**记一次有界例外**而不是改写成 Base UI —— 改写的成本
      // 不是一次性的，是每次从 registry 同步都要重做一遍的长期税。
      //
      // ⚠️ 2026-08-12 实测修正：这条闸原本写的是「registry 组件依赖 radix」，实际范围比那窄得多。
      // 96 个 `elements-*` 里只有 4 个(reasoning-panel / tool-call / tool-timeline / sources)拉
      // shadcn `collapsible`，而它们拉的是 shadcn 包装层、不是 radix 本身 —— 上游源码里
      // `group-data-open`(Radix) 与 `group-data-panel-open`(Base UI) 两套属性同时存在，它本来就是
      // 双栈写的；另有 1 个(inline-citation)直接用 `@base-ui/react`。本目录当前 radix import 数为 0。
      // ⇒ 闸继续留着(它是闸不是许可，且「豁免会腐烂而不报错」的理由不受影响)，
      //    但❌ 不要据这条注释推出「抄 Elements 就得吃 radix」——那个预期不成立。
      //
      // 但「写在 spec 里的豁免」会腐烂而不报错。所以边界由这条规则守：radix 的 import 只允许出现在
      // vendored assistant-ui 目录内，目录外出现即 lint 红。⚠️ 用的是 base 规则而不是
      // `@typescript-eslint/no-restricted-imports`，因为后者在上面那条 override 里已经被
      // task renderer 用掉了 —— 同名规则在 overrides 里是**替换**不是合并，写同一个名字会
      // 让两条闸互相拆台(先写的被后写的整条顶掉，而且不报任何错)。
      //
      // 也正因为它是 base 规则，type-only import 一样拦：`import type {...} from 'radix-ui'`
      // 编译期虽然会擦除，但它同样意味着把 radix 写进了依赖图。
      files: ['**/*.{ts,tsx,js,jsx,cjs,mjs}'],
      excludedFiles: ['apps/desktop/src/session/renderer/lib/ui/assistant-ui/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['radix-ui', 'radix-ui/*', '@radix-ui/*'],
                message:
                  'radix-ui 只允许出现在 apps/desktop/src/session/renderer/lib/ui/assistant-ui/(vendored assistant-ui Elements，#3334 记的有界例外)。产品代码的原语一律用 Base UI —— 见 design-system spec 的「组件模板只有一套」。'
              }
            ]
          }
        ]
      }
    },
    {
      // #2987 — 裸 <button style={...}> 手搓控件闸门。共享 Button 组件(components/ui/Button.tsx，
      // variant: primary/secondary/ghost/danger，size: sm/md/lg/icon)存在但采用率仅 1.3%，同一控件
      // 在不同页面尺寸/圆角/焦点环各异。这里只堵增量：存量 57 个命中文件豁免(#2987 建议②逐步清，
      // 不做一次性大扫除)，excludedFiles 之外新增/新落地的裸 button+style 直接拦。豁免数比 issue
      // 原始盘点的 38 个文件多，因为 selector 按属性名拦所有 style（不判断内容），会连带命中纯功能性
      // style（如 WindowControls.tsx 的 -webkit-app-region 拖拽区），不止 issue 定义的外观手搓那部分。
      // session/renderer 沿用与上面 task-fusion override 相同的目录级排除边界：
      // 它是独立并入的组件/视觉体系，不套用主应用的 Button，因此是永久的原则性排除；其余临时债
      // 来自机器可读 baseline，并由 shrink-only 元测试禁止扩张、催促删除陈旧条目。
      files: ['apps/desktop/src/**/*.tsx'],
      excludedFiles: [
        'apps/desktop/src/session/**',
        ...buttonStyleDebt
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "JSXOpeningElement[name.name='button'] > JSXAttribute[name.name='style']",
            message: '裸 <button style={...}> 已停止新增(#2987)——改用 components/ui/Button.tsx(variant/size 已覆盖多数场景);缺的 variant 先去补组件，别再手搓。'
          },
          // 顶层那条在这里是被整条替换掉的,不重新列一遍就等于给这批文件开了后门。
          noSyncSpawnInput
        ]
      }
    },
    {
      // @@@mjs-lint (#3766) —— `.mjs`/`.mts` 此前根本不在 lint 的 --ext 里,而 #3766 那个会让 CI
      // 挂死的写法恰恰住在 scripts/git-tree-blobs.mts。闸装在漏掉事发地的位置等于没装,所以纳进来。
      //
      // 纳进来点亮的存量**已经就地清掉**,不是靠在这里整片关规则换绿灯:未用变量 6 处按仓库既有的
      // `_` 前缀约定改掉、正则里的连续空格 2 处改成 {N}、一处 `catch (e) { throw e }` 直接拆掉。
      // 剩下两处是**有意为之**,用带理由的 inline disable 钉在出事的那一行,不做整类豁免:
      // ci-spec-coverage.mts 的 `\x1B` 正则本职就是剥 ANSI 转义;feedback-router-core.mjs 的
      // U+3000 是中文文案里的字段分隔符,换半角会改动用户看到的排版。
      // 用 inline 而不是在这里关:lint 带 --report-unused-disable-directives,哪天那行真被改好了,
      // 多余的 disable 自己会变红催人删 —— 这个退出路径是能走通的,整类关掉的那种走不通。
      //
      // 唯一留在这里的是 no-empty 的**窄化**而不是关闭:命中的 2 处都是空 catch,
      // 与上面 task-fusion override 第 71 行同一个理由、同一种写法。
      files: ['**/*.mjs', '**/*.mts'],
      rules: {
        'no-empty': ['error', { allowEmptyCatch: true }]
      }
    },
    {
      // `.d.mts` 是**手写入库**的环境声明,给那些没有类型的 .mjs 脚本描述对外形状(不是生成物)。
      // 里面的 any 多半是**准确描述**而非偷懒:被声明的那一侧本来就是动态类型的 JS。
      // 理由与上面 task-fusion override 关掉这条时写的完全一致 —— 凭空补类型,补错了就是拿一个
      // 不健全的断言换绿灯,比留着 any 更坏。真源码的 .mts(vite.config.mts、renderer-chunking.mts)
      // 不在此列,照常受这条规则约束。
      files: ['**/*.d.mts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off'
      }
    }
  ],
  rules: {
    'no-restricted-syntax': ['error', noSyncSpawnInput],
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // @@@task-fusion (#2802) — vars/caughtErrors 也认 `_` 前缀:会话页用 `const _x = ...` 表示
    // 「解构出来只为丢弃」,这是通用的意图标记,不该只对参数生效。
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
    ]
  }
}
