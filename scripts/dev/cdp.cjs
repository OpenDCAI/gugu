#!/usr/bin/env node
// Raw CDP helper for the gugu Electron renderer (Playwright connectOverCDP HANGS on Electron —
// use this raw-websocket client instead). Run from a dir with `ws` installed (e.g. the gugu repo).
//   node cdp.cjs eval '<JS expression>'          # Runtime.evaluate, prints JSON value (or exception)
//   node cdp.cjs shot out.png [y] [h] [w]        # Page.captureScreenshot, full page or clipped to bottom h
//   node cdp.cjs click '<selector>'              # querySelector + click()
//   node cdp.cjs type '<selector>' '<text>'      # React-safe value set (native setter + input event)
//                                                 # (React IGNORES direct el.value=; this is the fix)
//                                                 # works for input/textarea AND contentEditable
// Expects CDP at http://127.0.0.1:9223 (tunnel: ssh -fN -L 9223:127.0.0.1:9223 macmini-yatu).
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')

const CDP = 'http://127.0.0.1:9223'
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); r.on('error', rej) }))

;(async () => {
  const list = await get(`${CDP}/json/list`)
  const page = list.find((t) => t.type === 'page')
  if (!page) { console.error('no page target; is the app running with --remote-debugging-port?'); process.exit(1) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const rpc = (method, params = {}) => new Promise((res) => { const my = ++id; const h = (data) => { const m = JSON.parse(data); if (m.id === my) { ws.off('message', h); res(m.result) } }; ws.on('message', h); ws.send(JSON.stringify({ id: my, method, params })) })

  ws.on('open', async () => {
    await rpc('Runtime.enable')
    const [cmd, ...rest] = process.argv.slice(2)
    if (cmd === 'eval') {
      const r = await rpc('Runtime.evaluate', { expression: rest.join(' '), returnByValue: true, awaitPromise: true })
      const res = r.result || {}
      console.log(res.value !== undefined ? JSON.stringify(res.value) : 'EXC: ' + JSON.stringify(res.exceptionDetails?.exception || res.exceptionDetails || 'unknown'))
    } else if (cmd === 'shot') {
      await rpc('Page.enable')
      const [file, yStr, hStr, wStr] = rest
      const params = { format: 'png' }
      if (yStr != null) {
        const vp = await rpc('Page.getLayoutMetrics').then(m => ({ w: Math.round(m.cssContentSize.width), h: Math.round(m.cssContentSize.height) })).catch(() => ({ w: 1280, h: 800 }))
        params.clip = { x: 0, y: Number(yStr) || 0, width: Number(wStr) || vp.w, height: Number(hStr) || 300, scale: 1 }
      }
      const r = await rpc('Page.captureScreenshot', params)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      console.log('SHOT saved', file)
    } else if (cmd === 'click') {
      const expr = `(()=>{const el=document.querySelector(${JSON.stringify(rest[0] || '')});if(!el)return{err:'no element for ' + ${JSON.stringify(rest[0]||'')}};el.click();return{clicked:true}})()`
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true })
      const res = r.result || {}
      console.log(res.value !== undefined ? JSON.stringify(res.value) : 'EXC: ' + JSON.stringify(res.exceptionDetails?.exception || 'unknown'))
    } else if (cmd === 'type') {
      // React-safe: direct el.value= is ignored by React-controlled inputs; use the native property
      // setter + an input event. contentEditable uses innerText + InputEvent.
      const sel = rest[0] || ''
      const text = rest.slice(1).join(' ')
      const expr = `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return{err:'no element'};const t=${JSON.stringify(text)};if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const s=Object.getOwnPropertyDescriptor(proto,'value').set;s.call(el,t);el.dispatchEvent(new Event('input',{bubbles:true}))}else{el.focus();el.innerText=t;el.dispatchEvent(new InputEvent('input',{bubbles:true,data:t}))}return{ok:true,value:el.value||el.innerText}})()`
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true })
      const res = r.result || {}
      console.log(res.value !== undefined ? JSON.stringify(res.value) : 'EXC: ' + JSON.stringify(res.exceptionDetails?.exception || 'unknown'))
    } else {
      console.error('usage: node cdp.cjs eval "<js>" | shot out.png [y h w] | click "<sel>" | type "<sel>" "<text>"')
      process.exit(1)
    }
    ws.close(); process.exit(0)
  })
  setTimeout(() => { console.error('TIMEOUT'); process.exit(1) }, 12000)
})().catch((e) => { console.error('ERR', String(e).slice(0, 300)); process.exit(1) })
