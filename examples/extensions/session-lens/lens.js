/**
 * 任务镜 —— 把宿主告诉这张页的「你现在是给谁看的」原样照出来。
 *
 * 它是「扩展一律 app 级」最直白的示范:整个 app 只有这一张页,用户切到别的项目 / 会话,
 * 宿主推一次新的 context,这里重画;页面本身不重建。底部那行「本页启动于 … 已收到 N 次
 * 上下文变化」就是证据:切了多少次会话,启动时刻都不变。
 *
 * ❌ 不吞异常:哪个动词失败,错误原文就摆在它本该显示的位置上。
 */
const $ = (id) => document.getElementById(id);
const bootedAt = new Date();
let contextChanges = 0;
let current = null;
let lastFetch = 0;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
const absent = (why) => `<span class="muted">—(${esc(why)})</span>`;
const time = (d) => d.toLocaleTimeString('zh-CN', { hour12: false });

function paintWhere(ctx) {
  $('where').innerHTML = [
    row('项目 id', ctx.session?.projectId ? esc(ctx.session.projectId) : absent('这个任务不挂项目')),
    row('工作副本', ctx.session?.root ? esc(ctx.session.root) : absent('没有 / 未授 files:read')),
    row('session id', ctx.session ? esc(ctx.session.id) : absent('这一格不在任务里')),
    row('agent', ctx.session?.agentId ? esc(ctx.session.agentId) : absent('这个任务还没有 agent')),
    row('这一格', esc(ctx.tabId)),
    row('语言 / 主题', `${esc(ctx.locale)} / ${esc(ctx.themeMode)}`),
  ].join('');
}

async function paintWorkspace(ctx) {
  // 用 files:read 照一眼工作副本的根:项目名字光看 id 认不出来,根目录里有什么一眼就认得出。
  const el = document.getElementById('files');
  if (!ctx.session?.root) { el.innerHTML = absent('没有工作副本 / 未授 files:read'); return; }
  try {
    // 条目的 id 就是它在工作副本里的路径:根目录里有什么,取每条的第一段。
    const top = [...new Set((await window.gugu.files.list({ session: ctx.session.id })).map((e) => (e.id.includes('/') ? `${e.id.split('/')[0]}/` : e.id)))];
    const names = top.slice(0, 8).map(esc);
    el.innerHTML = names.length ? names.join(' · ') + (top.length > 8 ? ` · …共 ${top.length} 项` : '') : absent('空目录');
  } catch (error) {
    el.innerHTML = `<span class="err">files.list: ${esc(error.message ?? error)}</span>`;
  }
}

function paintAlive() {
  $('alive').textContent = `本页启动于 ${time(bootedAt)} · 已收到 ${contextChanges} 次上下文变化 · 上次取数 ${lastFetch ? time(new Date(lastFetch)) : '—'}`;
}

async function paintAgent(ctx) {
  const agentEl = $('agent');
  const histEl = $('history');
  if (!ctx.session?.agentId) {
    agentEl.innerHTML = row('状态', absent('没有当前任务'));
    histEl.innerHTML = '<span class="muted">没有当前任务</span>';
    return;
  }
  let agent = null;
  try {
    const agents = await window.gugu.listAgents();
    agent = agents.find((a) => a.agentId === ctx.session.agentId) ?? null;
    agentEl.innerHTML = agent
      ? [
          row('标题', esc(agent.title ?? '')),
          row('引擎', esc(agent.providerId ?? '—')),
          row('形态', `<span class="pill">${agent.transport === 'acp' ? '面板任务' : '终端任务'}</span>`),
          row('状态', esc(agent.status ?? '—')),
          row('同一任务里的 agent 数', String(agents.filter((a) => a.sessionId === ctx.session.id).length)),
        ].join('')
      : row('状态', absent('listAgents 里没有这个任务'));
  } catch (error) {
    agentEl.innerHTML = row('listAgents', `<span class="err">${esc(error.message ?? error)}</span>`);
    histEl.innerHTML = '';
    return;
  }
  if (!agent) { histEl.innerHTML = '<span class="muted">—</span>'; return; }
  try {
    // 只按 nextCursor 判断到没到头;一页可能全是工具调用、没人说话。
    const users = [];
    let before;
    for (let page = 0; page < 6 && users.length < 10; page++) {
      const { messages, nextCursor } = await window.gugu.readAgentHistory(agent.agentId, before);
      for (const m of messages.slice().reverse()) if (m.sender === 'user') users.push(m);
      if (!nextCursor) break;
      before = nextCursor;
    }
    const last = users.slice(0, 10).reverse();
    histEl.innerHTML = last.length
      ? `<ol>${last.map((m) => `<li>${esc(m.text.slice(0, 120))}${m.text.length > 120 ? '…' : ''}<small>#${m.seq}</small></li>`).join('')}</ol>`
      : '<span class="muted">这个任务里用户还没说过话</span>';
  } catch (error) {
    // 按码判:读不到(没打开,且它那家引擎的记录咕咕读不了)不是出错。
    histEl.innerHTML = error.code === 'unavailable'
      ? '<span class="muted">这个任务的对话现在读不到(没打开,且它那家引擎的记录咕咕读不了)</span>'
      : `<span class="err">readAgentHistory: ${esc(error.message ?? error)}</span>`;
  }
}

async function refresh() {
  if (!current) return;
  lastFetch = Date.now();
  paintWhere(current);
  paintAlive();
  await Promise.all([paintWorkspace(current), paintAgent(current)]);
}

// 读了工作副本就得听它的变化:agent 一落盘,根目录那一行要跟着变。听的是这一格所在的那条会话,点名说出来(真源原则 13)。
let unwatch = null;
function watchSession(ctx) {
  unwatch?.();
  unwatch = ctx.session?.root ? window.gugu.files.onChanged({ session: ctx.session.id }, () => { if (current) void paintWorkspace(current); }) : null;
}

window.gugu.onContextChanged((ctx) => {
  const switched = !current || current.session?.id !== ctx.session?.id || current.session?.agentId !== ctx.session?.agentId;
  current = ctx;
  if (switched) { contextChanges += 1; watchSession(ctx); void refresh(); } else { paintWhere(ctx); paintAlive(); }
});
window.gugu.onAgentsChanged(() => void refresh());
window.gugu.onCommand((id) => { if (id === 'refresh') void refresh(); });

window.gugu.getContext().then((ctx) => { current = ctx; watchSession(ctx); return refresh(); }).catch((error) => {
  $('where').innerHTML = row('getContext', `<span class="err">${esc(error.message ?? error)}</span>`);
});
