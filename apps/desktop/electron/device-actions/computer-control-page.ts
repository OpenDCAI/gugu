import { ICON_BODIES } from '@gugu/session-ui/icon-bodies'

// Approved compact window-head silhouette. The mask is surface geometry, not an icon.
const HEAD_MASK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 236 44"><path d="M0 44C6 44 10 40 10 33V17C10 7 18 2 30 2H116C128 2 138 5 147 9C153 12 160 12 169 12H203C217 12 226 19 226 30V33C226 41 229 44 236 44Z"/></svg>')}`
const icon = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`

/** A sandboxed native panel cannot inherit renderer CSS. Values mirror the
 * neutral surface/type/control tokens in src/styles/tokens.css. */
export const COMPUTER_CONTROL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: light dark; --surface: #fff; --fg: #1a1c1f; --muted: #68696b; --button: #f1f1ef; --button-hover: #e8e8e5; --pressed: #dededb; --primary: #1a1c1f; --primary-fg: #fff; --green: #16a34a; }
@media (prefers-color-scheme: dark) { :root { --surface: #212121; --fg: #dfdfdf; --muted: #939393; --button: #ffffff12; --button-hover: #ffffff1d; --pressed: #ffffff27; --primary: #dfdfdf; --primary-fg: #212121; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: default; }
body { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
.bar { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 19px; height: 44px; padding: 5px 15px 2px 25px; color: var(--fg); filter: drop-shadow(0 -1px 0 #0000000d) drop-shadow(0 -3px 4px #00000004); }
.bar::before { content: ''; position: absolute; inset: 0; background: var(--surface); mask-image: url('${HEAD_MASK}'); mask-size: 100% 100%; mask-repeat: no-repeat; pointer-events: none; }
.identity, button { position: relative; }
.identity { min-width: 0; align-self: start; }
.byline { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; line-height: 15px; white-space: nowrap; }
.agent { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.dot { flex: none; width: 5px; height: 5px; margin-right: 1px; border-radius: 50%; background: var(--green); }
.task { font-size: 14px; font-weight: 500; line-height: 18px; letter-spacing: -.15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.identity[data-task=false] { align-self: center; }
.identity[data-task=false] .byline { font-size: 14px; line-height: 20px; color: var(--fg); }
button { display: flex; align-items: center; justify-content: center; align-self: end; gap: 4px; height: 28px; min-width: 56px; padding: 0 8px; border: 0; border-radius: 8px; background: var(--button); color: var(--fg); font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer; transition: background 100ms; }
button:hover { background: var(--button-hover); }
button:active { background: var(--pressed); }
button:focus-visible { outline: 2px solid var(--muted); outline-offset: 1px; }
button > * { pointer-events: none; }
button svg { display: block; width: 12px; height: 12px; }
[hidden] { display: none !important; }
.bar[data-state=paused] .dot { background: transparent; box-shadow: inset 0 0 0 1.3px var(--muted); }
.bar[data-state=paused] button { background: var(--primary); color: var(--primary-fg); }
.bar[data-state=paused] button:hover { background: color-mix(in srgb, var(--primary) 86%, var(--surface)); }
body[data-attachment=inside] .bar { padding-top: 2px; padding-bottom: 5px; filter: drop-shadow(0 1px 0 #0000000d); }
body[data-attachment=inside] .bar::before { transform: scaleY(-1); }
body[data-attachment=inside] .identity { align-self: end; }
body[data-attachment=inside] button { align-self: start; }
body[data-attachment=inside] .identity[data-task=false] { align-self: center; }
body[data-attachment=floating] .bar { padding-left: 16px; padding-right: 8px; }
body[data-attachment=floating] .bar::before { mask-image: none; border-radius: 8px; }
</style></head><body><div class="bar" role="status" data-state="driving"><div class="identity"><div class="byline"><span class="dot" aria-hidden="true"></span><span class="agent"></span></div><div class="task"></div></div><button type="button"><span class="stop-icon">${icon(ICON_BODIES.Square)}</span><span class="resume-icon" hidden>${icon(ICON_BODIES.Play)}</span><span class="button-label"></span></button></div>
<script>
const bar = document.querySelector('.bar'), identity = document.querySelector('.identity'), agent = document.querySelector('.agent'), task = document.querySelector('.task'), button = document.querySelector('button'), label = document.querySelector('.button-label'), stopIcon = document.querySelector('.stop-icon'), resumeIcon = document.querySelector('.resume-icon')
let action = 'stop'
window.render = (view) => {
  const hasTask = view.attachment !== 'floating' && Boolean(view.taskTitle)
  bar.dataset.state = view.state
  bar.setAttribute('aria-label', view.text)
  document.body.dataset.attachment = view.attachment
  identity.dataset.task = String(hasTask)
  identity.title = view.text
  agent.textContent = view.attachment === 'floating' ? view.text : view.agentName
  agent.title = view.agentName
  task.hidden = !hasTask
  task.textContent = view.taskTitle || ''
  task.title = view.taskTitle || ''
  label.textContent = view.button
  button.setAttribute('aria-label', view.button + ' · ' + view.agentName)
  stopIcon.hidden = view.action !== 'stop'
  resumeIcon.hidden = view.action !== 'resume'
  action = view.action
}
button.addEventListener('click', () => { location.href = 'gugu-computer-bar:' + action })
</script></body></html>`
