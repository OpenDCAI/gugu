#!/usr/bin/env node
// @@@mobile-launch-loading (#5714) — 把「咕咕唯一的加载态」那段动效搬进安卓的系统启动画面。
//
// 安卓那一屏由系统画,吃的是一张 AnimatedVectorDrawable,认不了 Lottie。所以必须做一次转换 ——
// 但 ❌ 不许手抄关键帧:那等于产品里多出第二份「差不多但不一样」的加载动效。
//
// 这个脚本用**产品自己那套渲染器**(lottie-web,与 LoadingIndicator.tsx 同一个)把动效逐帧量出来
// (每帧 8 个点的圆心/半径/颜色),再照量到的数写成 AVD。换动效只要重跑一次;
// tests/unit/mobile/splash-avd-matches-loading-animation.test.ts 会在两者对不上时红。
//
//   pnpm exec node scripts/build/gen-mobile-splash-avd.mjs          # 写入资源
//   pnpm exec node scripts/build/gen-mobile-splash-avd.mjs --check   # 只比对,不写(测试用)
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const LOTTIE_DATA = `${REPO}packages/session-ui/src/react/components/loading-indicator/loading-animation.data.ts`
const OUT = `${REPO}apps/mobile/android/app/src/main/res/drawable/splash_loading.xml`

// 一圈 60 帧 / 30fps = 2000ms —— 取自素材自己的 fr 与 op,不是拍脑袋的。
const SAMPLES = 60
// 墨迹宽度 84dp:与 LoadingIndicator 的 `page` 档(INK_WIDTH.page = 84)逐字一致,
// 手机上 1 CSS px = 1dp,所以系统那一屏交接到 WebView 那一屏时大小不跳。
const INK_WIDTH_DP = 84
// 画布 288dp:安卓「无图标底色」形态下启动画面图标的画布尺寸(可见圆 192dp 居中)。
const CANVAS_DP = 288
// 浅色主题的前景色 = --text-primary(#171717);素材的两档明暗按 LoadingIndicator.css 的规则接线:
// 纯白那一组 = 前景色本身,#C8C8C8 那一组 = 78.4% 透明度(200/255,取自素材自己的两色之比)。
const INK_FULL = '#171717'
const INK_DIM = '#C8171717'

function lottiePlayerPath() {
  const base = `${REPO}node_modules/.pnpm`
  const dir = readdirSync(base).find((d) => d.startsWith('lottie-web@'))
  if (!dir) throw new Error('lottie-web 没装上,先 pnpm install')
  return `${base}/${dir}/node_modules/lottie-web/build/player/lottie_light.js`
}

async function sampleFrames() {
  const src = readFileSync(LOTTIE_DATA, 'utf8')
  const tail = src.slice(src.indexOf('= {') + 2)
  const data = JSON.parse(tail.slice(0, tail.lastIndexOf('}') + 1))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="host" style="width:800px;height:600px"></div>')
    await page.addScriptTag({ content: readFileSync(lottiePlayerPath(), 'utf8') })
    return await page.evaluate(
      ({ data, samples }) => {
        const anim = window.lottie.loadAnimation({
          container: document.getElementById('host'),
          renderer: 'svg',
          loop: false,
          autoplay: false,
          animationData: data,
        })
        const svg = document.querySelector('#host svg')
        const vb = svg.viewBox.baseVal
        const out = []
        for (let f = 0; f < samples; f++) {
          anim.goToAndStop(f, true)
          const host = svg.getBoundingClientRect()
          const sx = vb.width / host.width
          const dots = []
          for (const el of svg.querySelectorAll('path')) {
            const box = el.getBoundingClientRect()
            if (box.width < 0.01) continue
            dots.push({
              cx: (box.x - host.x + box.width / 2) * sx,
              cy: (box.y - host.y + box.height / 2) * sx,
              r: (box.width / 2) * sx,
              fill: getComputedStyle(el).fill,
            })
          }
          out.push(dots)
        }
        return out
      },
      { data, samples: SAMPLES },
    )
  } finally {
    await browser.close()
  }
}

const round = (n) => Number(n.toFixed(3))

// 素材指纹:让单测能在**不起浏览器**的前提下判出「动效换了但这份没重生成」。
export const SOURCE_STAMP = '源素材 loading-animation.data.ts sha256: '
const sourceHash = () => createHash('sha256').update(readFileSync(LOTTIE_DATA)).digest('hex')

function buildAvd(frames) {
  const count = frames[0].length
  for (const f of frames) {
    if (f.length !== count) throw new Error(`每帧点数不一致(${count} vs ${f.length}),素材换了,这个脚本要重写`)
  }
  // 点的身份 = 列 x + 颜色(每列一白一灰,整段动画里两者都不变)。
  // ❌ 不能按 DOM 顺序对号:素材在一圈里会把画同一个点的图层换掉,节点顺序跟着变。
  const key = (d) => `${round(d.cx)}|${d.fill}`
  const ids = [...new Set(frames[0].map(key))].sort()
  if (ids.length !== count) throw new Error('同一列同一色出现了不止一个点,素材换了,这个脚本要重写')
  const byId = frames.map((f) => {
    const m = new Map(f.map((d) => [key(d), d]))
    if (ids.some((id) => !m.has(id))) throw new Error('某一帧少了点,素材换了,这个脚本要重写')
    return m
  })

  const all = frames.flat()
  const bounds = {
    minY: Math.min(...all.map((d) => d.cy - d.r)),
    maxY: Math.max(...all.map((d) => d.cy + d.r)),
    minX: Math.min(...all.map((d) => d.cx - d.r)),
    maxX: Math.max(...all.map((d) => d.cx + d.r)),
  }
  const k = INK_WIDTH_DP / (bounds.maxX - bounds.minX)
  const cxMid = (bounds.minX + bounds.maxX) / 2
  const cyMid = (bounds.minY + bounds.maxY) / 2
  const mid = CANVAS_DP / 2
  const baseR = Math.max(...all.map((d) => d.r)) / 1.5 // 素材的 scale 在 50%~150% 之间,反推 100% 的半径

  const groups = []
  const targets = []
  ids.forEach((id, i) => {
    const d0 = byId[0].get(id)
    const name = `dot${i}`
    const x = round(mid + (d0.cx - cxMid) * k)
    const r = round(baseR * k)
    const fill = d0.fill === 'rgb(255, 255, 255)' ? INK_FULL : INK_DIM
    groups.push(
      `      <group android:name="${name}" android:translateX="${x}" android:translateY="${mid}">\n` +
        `        <path android:fillColor="${fill}"\n` +
        `            android:pathData="M ${round(-r)},0 a ${r},${r} 0 1,0 ${round(r * 2)},0 a ${r},${r} 0 1,0 ${round(-r * 2)},0" />\n` +
        `      </group>`,
    )
    const ty = byId.map((m) => round((m.get(id).cy - cyMid) * k))
    const sc = byId.map((m) => round(m.get(id).r / baseR))
    targets.push(target(name, ty, sc))
  })

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!--\n` +
    `  ⚠️ 生成物,❌ 别手改。改动效要改 packages/session-ui/src/react/components/loading-indicator/loading-animation.data.ts,\n` +
    `  再跑 \`node scripts/build/gen-mobile-splash-avd.mjs\` 重新生成。\n` +
    `  ${SOURCE_STAMP}${sourceHash()}\n` +
    `  @@@mobile-launch-loading (#5714) —— 安卓系统启动画面里播的就是「咕咕唯一的加载态」那一段,\n` +
    `  于是点开 App 到界面画出来,从头到尾只有一个加载动效,中间不换脸。\n` +
    `-->\n` +
    `<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"\n` +
    `    xmlns:aapt="http://schemas.android.com/aapt">\n` +
    `  <aapt:attr name="android:drawable">\n` +
    `    <vector android:width="${CANVAS_DP}dp" android:height="${CANVAS_DP}dp"\n` +
    `        android:viewportWidth="${CANVAS_DP}" android:viewportHeight="${CANVAS_DP}">\n` +
    groups.join('\n') +
    `\n    </vector>\n` +
    `  </aapt:attr>\n` +
    targets.join('\n') +
    `\n</animated-vector>\n`
  )
}

function keyframes(values) {
  return values
    .map((v, i) => `          <keyframe android:fraction="${round(i / values.length)}" android:value="${v}" />`)
    .concat([`          <keyframe android:fraction="1" android:value="${values[0]}" />`])
    .join('\n')
}

function holder(property, values) {
  return (
    `        <propertyValuesHolder android:propertyName="${property}" android:valueType="floatType">\n` +
    keyframes(values) +
    `\n        </propertyValuesHolder>`
  )
}

function target(name, ty, sc) {
  return (
    `  <target android:name="${name}">\n` +
    `    <aapt:attr name="android:animation">\n` +
    `      <objectAnimator xmlns:android="http://schemas.android.com/apk/res/android"\n` +
    `          android:duration="2000" android:repeatCount="infinite" android:repeatMode="restart"\n` +
    `          android:interpolator="@android:anim/linear_interpolator">\n` +
    holder('translateY', ty.map((v) => round(v + CANVAS_DP / 2))) +
    `\n` +
    holder('scaleX', sc) +
    `\n` +
    holder('scaleY', sc) +
    `\n      </objectAnimator>\n` +
    `    </aapt:attr>\n` +
    `  </target>`
  )
}

const xml = buildAvd(await sampleFrames())
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== xml) {
    console.error(`${OUT} 与加载动效素材对不上了 —— 跑 node scripts/build/gen-mobile-splash-avd.mjs 重新生成`)
    process.exit(1)
  }
  console.log('splash AVD 与加载动效一致')
} else {
  writeFileSync(OUT, xml)
  console.log(`写入 ${OUT}`)
}
