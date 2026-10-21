/**
 * 全局选择吸收态取证器 —— issue #4259 的一号仪器
 *
 * 它回答的问题:「全局无法框选文字」到底是哪一族造成的。这不是猜,是把症状翻译成可判定的 DOM 事实,
 * 判据来自一张【实测】的机制→症状签名矩阵(真 Chromium,可信输入):
 *
 *   施加的机制(作用在 #root 上)      普通文本  <input>  <textarea>  contenteditable  portal弹层  点击
 *   ────────────────────────────────────────────────────────────────────────────────────────────
 *   干净(基线)                          19      20        20            19            19       ✓
 *   inert                                0       0         0             0            19       ✗
 *   draggable=true                       0       0        20            19            19       ✓
 *   mousedown preventDefault(capture)    0       0         0             0            19       ✓   ← #4259 症状唯一匹配
 *   body{pointer-events:none}            0       0         0             0            19       ✗
 *   卡住的 setPointerCapture            19      20        20            19            19       ✓
 *
 * 两条会误导人的实测事实,写在这里免得下一个人再踩:
 *   ① 任何形式的 user-select:none(继承 / 直接设在控件上 / -webkit-…!important)都【拦不住】
 *      <input>/<textarea>/contenteditable 的拖选。但 getComputedStyle(input).userSelect 这时确实报 none
 *      —— computed 与行为在这里分叉,只读 computed 会把人骗进错的一族。
 *   ② -webkit-user-select 是 user-select 的真别名,共用同一条 inline 声明槽:
 *      写 style.webkitUserSelect 后 style.cssText 就是 "user-select: …",且能从 style.userSelect 读回。
 *
 * ── 怎么用 ────────────────────────────────────────────────────────────────────────────────
 * 真机(推荐):打开 DevTools Console,整段粘贴本文件,回车。然后照常用产品,直到撞进「划不动」。
 *            撞进去后执行:
 *                __SELFOR.verdict()    ← 一行判族 + 点名肇事者(函数名 + 注册栈)
 *                __SELFOR.layers()     ← 主渲染层 vs 会话页:哪一层的 mousedown 被拦(定位杠杆最强的一格)
 *                __SELFOR.report()     ← 完整取证报告,整段贴回 issue #4259
 *
 *            ⚠️ 事后粘贴仍然有用:吸收态**不会自己退出**,所以装上探针之后的每一次真实 mousedown
 *            都会被记账并点名肇事者。只有「探针安装之前的那批 addEventListener 注册」漏在可见域外
 *            —— 报告里的监听器清单要按这一点打折读,preventDefault 归属不受影响。
 *
 * 自动化:以 addInitScript 注入,【必须早于应用代码】,否则监听器记账会漏掉早期注册。
 *
 * ── 它记什么 ──────────────────────────────────────────────────────────────────────────────
 *   Q1 CSS 族     body/html 的 inline 与 computed user-select、draggable、任何提到 user-select 的样式规则
 *   Q2 事件族     所有 mousedown/pointerdown/selectstart 监听器(任何元素,按视口覆盖比排序)
 *                 + 谁真的调用了 preventDefault(带注册栈)
 *   Q3 遮挡族     四个采样点上 elementFromPoint 命中谁,它的 pointer-events / user-select / -webkit-app-region
 *   Q4 进入时刻   最近 60 条 pointer/focus/visibility 事件(owner 要求:要能看见进入吸收态前那一批事件序列)
 *   Q5 焦点族     document.hasFocus() / activeElement 是不是 iframe·webview / 选区 rangeCount
 *                 (Electron 下 <webview> 抢走焦点会让宿主文档起不了选,而点击照常 —— 这一族裸浏览器里测不到)
 *
 * ⚠️ 取栈很贵。加宽可见域后若对每一次注册都取栈,dev 下的真 Electron 渲染器会被拖到起不来,
 *    所以元素级注册的取栈有预算上限(全局 target 永远取)。
 *
 * ❌ 这个文件不进产品包(仓库铁律:产品内不埋测试探针)。它是 devtools / e2e 的外挂仪器。
 */

(() => {
  if (globalThis.__SELFOR) { console.warn('[selfor] 已安装'); return }

  const RING = 200
  const events = []
  const listeners = new Map()   // id -> {target, type, capture, stack}
  const prevents = []           // preventDefault 归属记录
  let seq = 0

  const targetName = (t) =>
    t === window ? 'window' : t === document ? 'document' : t === document.body ? 'body'
    : t && t.nodeType === 1 ? `<${t.tagName.toLowerCase()}${t.id ? '#' + t.id : ''}${t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}>`
    : String(t)

  // ⚠️ 取栈很贵(dev 下要解 source map)。加宽可见域后如果对每一次注册都取栈,
  //    真 Electron 的渲染器会被拖到起不来(实测:装了探针 rootChildCount 恒为 0,
  //    去掉探针同一条 spec 就过)。所以给它一个预算:全局 target 永远取,
  //    元素 target 只在预算内取——早期注册(应用自己的容器级监听)必然落在预算内。
  let stackBudget = 400
  const stackOf = (always) => {
    if (!always && stackBudget <= 0) return '(stack budget exhausted)'
    if (!always) stackBudget--
    const s = new Error().stack || ''
    return s.split('\n').slice(3, 8).map((l) => l.trim()).join(' | ')
  }

  // ── 记账:全局监听器注册表 ────────────────────────────────────────────────
  // ⚠️ 可见域:不能只看 window/document —— portal 弹层是 #root 的兄弟节点,
  //    所以「挂在 #root 上的 capture 监听」会放过弹层却吃掉其余一切。
  //    这里记录【任何】元素上的这些类型,报告时再按它覆盖视口的比例排序。
  const WATCH = new Set(['mousedown', 'pointerdown', 'selectstart', 'dragstart', 'mouseup', 'pointerup', 'pointercancel'])
  const origAdd = EventTarget.prototype.addEventListener
  const origRemove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (WATCH.has(type)) {
      const capture = typeof opts === 'object' ? !!opts.capture : !!opts
      const id = ++seq
      const isGlobal = this === window || this === document || this === document.body || this === document.documentElement
      listeners.set(id, { target: targetName(this), type, capture, stack: stackOf(isGlobal), fn, node: this })
      try { fn && (fn.__selforId = id) } catch { /* 冻结的函数打不上标记;不影响记账,别为它 fail */ }
    }
    return origAdd.call(this, type, fn, opts)
  }
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (fn && fn.__selforId) listeners.delete(fn.__selforId)
    return origRemove.call(this, type, fn, opts)
  }

  // ── 归属:谁调用了 preventDefault ─────────────────────────────────────────
  const origPD = Event.prototype.preventDefault
  Event.prototype.preventDefault = function () {
    if (WATCH.has(this.type)) {
      prevents.push({
        t: Math.round(performance.now()), type: this.type,
        currentTarget: targetName(this.currentTarget),
        eventPhase: ['NONE', 'CAPTURE', 'AT_TARGET', 'BUBBLE'][this.eventPhase],
        stack: stackOf(true),
      })
      if (prevents.length > RING) prevents.shift()
    }
    return origPD.call(this)
  }

  // ── Q4:进入时刻的事件序列 ───────────────────────────────────────────────
  const rec = (e) => {
    events.push({
      t: Math.round(performance.now()), type: e.type,
      target: targetName(e.target),
      buttons: e.buttons, pointerId: e.pointerId,
      visibility: document.visibilityState, hasFocus: document.hasFocus(),
    })
    if (events.length > RING) events.shift()
  }
  for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture',
                   'mousedown', 'mouseup', 'dragstart', 'dragend', 'drop',
                   'focus', 'blur', 'visibilitychange', 'selectstart'])
    origAdd.call(t === 'visibilitychange' ? document : window, t, rec, true)

  // ── 自动判定:真实按下之后,默认动作还在不在 ───────────────────────────────
  const verdicts = []
  origAdd.call(window, 'mousedown', (e) => {
    // 冒泡末端读:此刻所有应用监听器都已跑完
    setTimeout(() => {
      if (e.defaultPrevented) {
        verdicts.push({
          t: Math.round(performance.now()),
          verdict: 'MOUSEDOWN_DEFAULT_PREVENTED',
          target: targetName(e.target),
          culprits: prevents.filter((p) => Math.abs(p.t - Math.round(e.timeStamp)) < 50),
        })
      }
    }, 0)
  }, false)

  const cssProbe = () => {
    const sheets = []
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules } catch { sheets.push({ href: ss.href, note: 'CORS 不可读' }); continue }
      for (const r of rules) if (r.cssText && /user-select/.test(r.cssText))
        sheets.push({ href: ss.href || '(inline/adopted)', rule: r.cssText.slice(0, 160) })
    }
    for (const ss of document.adoptedStyleSheets || []) {
      for (const r of ss.cssRules) if (/user-select|cursor/.test(r.cssText))
        sheets.push({ href: '(adoptedStyleSheets)', rule: r.cssText.slice(0, 160) })
    }
    return sheets
  }

  const overlayProbe = () => {
    const pts = [[innerWidth * .5, innerHeight * .5], [innerWidth * .25, innerHeight * .5],
                 [innerWidth * .75, innerHeight * .75], [innerWidth * .5, innerHeight * .9]]
    return pts.map(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      const cs = el && getComputedStyle(el)
      return { at: [Math.round(x), Math.round(y)], el: targetName(el),
               pointerEvents: cs && cs.pointerEvents, userSelect: cs && cs.userSelect,
               appRegion: cs && cs.getPropertyValue('-webkit-app-region'),
               zIndex: cs && cs.zIndex, position: cs && cs.position }
    })
  }

  // Q5 焦点族:Electron 下 <webview>/BrowserView 抢走焦点后,宿主文档起不了选,但点击照常。
  //    这一族在裸浏览器里测不到,只能读状态。
  const focusProbe = () => {
    const ae = document.activeElement
    return {
      documentHasFocus: document.hasFocus(),
      activeElement: ae ? `<${ae.tagName.toLowerCase()}${ae.id ? '#' + ae.id : ''}>` : null,
      activeElementIsFrameLike: !!ae && ['IFRAME', 'WEBVIEW'].includes(ae.tagName),
      selectionRangeCount: (window.getSelection() || { rangeCount: 0 }).rangeCount,
      framesInDocument: document.querySelectorAll('iframe, webview').length,
      visibilityState: document.visibilityState,
    }
  }

  // Q6 分层族:owner 2026-08-26 实测「吸收态发生时,task 页似乎不太受影响」。
  //    task 页与咕咕主渲染层是同一个 document 里的两棵子树 ⇒ 若肇事者挂在 **document** 上,
  //    两层应当同样中招;只有一层中招 ⇒ 肇事者的作用域是那一层的**容器子树**。
  //    这一格把「哪一层」变成读数,并把每层祖先链上真正注册着的 pointer 监听按 target 列出来 ——
  //    谁在主层有、task 层没有,谁就是嫌疑人。
  //
  //    ⚠️ 可见域:这里派发的是**合成** mousedown。它会跑完所有监听器并如实反映 defaultPrevented
  //    与肇事者,但它**不测浏览器的原生选择行为** —— 「用户划不划得动」仍以真拖动为准。
  const layerRoots = () => {
    const sessionMount = globalThis.__EMDASH_MOUNT__
      || document.querySelector('.gg-session-frame-host')
      || document.querySelector('.gugu-skin[class*="emlight"], .gugu-skin[class*="emdark"]')
    const appRoot = document.getElementById('root') || document.body
    return [
      { layer: 'main-renderer', root: appRoot, exclude: sessionMount || null },
      { layer: 'session-page', root: sessionMount || null, exclude: null },
    ]
  }

  const sampleTextElement = (root, exclude) => {
    if (!root) return null
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walk.nextNode())) {
      if ((n.textContent || '').trim().length < 8) continue
      const el = n.parentElement
      if (!el) continue
      if (exclude && exclude.contains(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 40 || r.height < 8) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      return { el, rect: r }
    }
    return null
  }

  const layerProbe = () => layerRoots().map(({ layer, root, exclude }) => {
    if (!root) return { layer, note: '这一层在本文档里不存在(未测量,❌ 不是阴性)' }
    const hit = sampleTextElement(root, exclude)
    if (!hit) return { layer, note: '这一层里找不到可采样的文本(未测量,❌ 不是阴性)' }
    const before = prevents.length
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(hit.rect.left + Math.min(8, hit.rect.width / 2)),
      clientY: Math.round(hit.rect.top + Math.min(8, hit.rect.height / 2)),
    })
    hit.el.dispatchEvent(ev)
    // 该层祖先链上真正注册着的 pointer 监听(来自记账表),按 target 列出。
    const chain = []
    for (let p = hit.el; p; p = p.parentElement) chain.push(p)
    const onChain = [...listeners.values()].filter(({ node, type }) =>
      (type === 'mousedown' || type === 'pointerdown' || type === 'selectstart')
      && node && (node === window || node === document || chain.includes(node)))
      .map(({ target, type, capture, stack }) => `${target} ${type} cap=${capture} :: ${String(stack).slice(0, 160)}`)
    return {
      layer,
      sampledElement: targetName(hit.el),
      sampledText: (hit.el.textContent || '').trim().slice(0, 24),
      syntheticMousedownDefaultPrevented: ev.defaultPrevented,
      culprits: prevents.slice(before).map((p) =>
        `${p.type}@${p.eventPhase} ct=${p.currentTarget} :: ${String(p.stack).slice(0, 220)}`),
      pointerListenersOnAncestorChain: [...new Set(onChain)],
    }
  })

  globalThis.__SELFOR = {
    /**
     * 分层判定 —— 「主渲染层中招、task 页没中」这条 owner 观察的读数化。
     * 单独暴露是因为它是**目前最强的定位杠杆**:它把嫌疑面从 document 缩到某一层的容器子树。
     */
    layers() {
      const r = layerProbe()
      console.log('%c[selfor] 分层', 'font-weight:bold')
      console.log(JSON.stringify(r, null, 2))
      return r
    },
    // 一行判族。判据来自实测的签名矩阵,不是猜。
    verdict() {
      const r = this.report()
      const pd = r.Q2_events.recent_preventDefault_calls
        .filter((p) => p.type === 'mousedown' || p.type === 'pointerdown')
      const lines = []
      if (pd.length) lines.push(`事件族:mousedown/pointerdown 被 preventDefault —— 肇事者:\n` +
        pd.slice(-5).map((p) => `    ${p.type}@${p.eventPhase} target=${p.currentTarget}\n      ${p.stack}`).join('\n'))
      if (r.Q1_css.body_computed_userSelect === 'none')
        lines.push('CSS 族:body computed user-select=none(⚠️ 实测它拦不住 input/textarea/contenteditable,单靠它解释不了"输入框也不可选")')
      const ovl = r.Q3_overlay.filter((o) => o.pointerEvents === 'none' || o.appRegion === 'drag')
      if (ovl.length) lines.push('遮挡/拖拽区族:' + JSON.stringify(ovl))
      if (!r.Q5_focus.documentHasFocus) lines.push('焦点族:document.hasFocus()=false —— 宿主文档没有焦点(Electron 下常见于 <webview>/BrowserView 抢焦点)')
      if (r.Q5_focus.activeElementIsFrameLike) lines.push('焦点族:activeElement 是 ' + r.Q5_focus.activeElement + ' —— 焦点在子框架里')
      lines.push('作用域还没判:执行 __SELFOR.layers() —— 它会往每一层派发一次真的 mousedown,\n' +
        '    所以刻意不放在 verdict()/report() 里(那两个必须只读)。两层读数不同 ⇒ 肇事者挂在某一层的容器子树上,不是 document。')
      const out = lines.length ? lines.join('\n') : '未判定:上述各族均无阳性读数(不要在这里补一个听起来顺的机制)'
      console.log('%c[selfor] 判族\n' + out, 'font-weight:bold')
      return out
    },
    report() {
      const b = document.body, h = document.documentElement
      const r = {
        Q1_css: {
          body_inline_cssText: b.style.cssText,
          body_computed_userSelect: getComputedStyle(b).userSelect,
          html_inline_cssText: h.style.cssText,
          html_computed_userSelect: getComputedStyle(h).userSelect,
          body_draggable: b.getAttribute('draggable'),
          rules_mentioning_user_select: cssProbe(),
        },
        Q2_events: {
          live_global_listeners: [...listeners.values()].map(({ target, type, capture, stack, node }) => {
            // 覆盖比:该监听目标覆盖了多大比例的视口。1 = 全窗(window/document 视为 1)。
            let coverage = 1, detached = false
            if (node && node.nodeType === 1) {
              const r = node.getBoundingClientRect()
              coverage = Math.min(1, (r.width * r.height) / (innerWidth * innerHeight) || 0)
              detached = !document.contains(node)
            }
            return { target, type, capture, stack, coverage: Math.round(coverage * 100) / 100, detached }
          }).sort((a, b) => b.coverage - a.coverage),
          recent_preventDefault_calls: prevents.slice(-25),
          verdicts: verdicts.slice(-10),
        },
        Q3_overlay: overlayProbe(),
        Q4_last_events: events.slice(-60),
        Q5_focus: focusProbe(),
        // ⚠️ Q6 分层格**不在这里**:它要往页面里派发真的 mousedown,而 report()/verdict()
        //    必须是只读的 —— 一支会改变被测态的取证器,读到的是它自己造出来的态。
        //    分层读数走显式的 __SELFOR.layers()。
      }
      console.log('%c[selfor] 取证报告', 'font-weight:bold')
      console.log(JSON.stringify(r, null, 2))
      return r
    },
    raw: { events, listeners, prevents, verdicts },
  }
  console.log('%c[selfor] 已安装。撞进"无法框选"后执行 __SELFOR.report()', 'color:#0a0;font-weight:bold')
})()
