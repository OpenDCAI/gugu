/**
 * cache 保温器 —— 视图。钟和状态都在后台页(background.js);这里只把它广播来的状态画出来,
 * 人点了什么就原样告诉后台。
 *
 * 会话的标题是 agent 自己起的:一律 textContent,❌ innerHTML。
 */
const $ = (id) => document.getElementById(id);
const SHOWN = 40;
let latest = null;
let showAll = false;

const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

function tell(message) {
  window.gugu.sendToBackground(message).catch((error) => {
    $('status').textContent = `后台页没收到:${error?.message ?? error}`;
    $('status').className = 'line bad';
  });
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function chip(text, kind) {
  const span = document.createElement('span');
  span.className = `chip${kind ? ` ${kind}` : ''}`;
  span.textContent = text;
  return span;
}

/** 这个会话的缓存此刻是什么样,和后台判 ping 用的是同一条规则。 */
function cacheOf(rec, state, at) {
  if (rec.status === 'working') return chip('在跑');
  if (rec.status === 'needs_user') return chip('等人');
  if (rec.status === 'error') return chip('报错', 'bad');
  if (rec.status !== 'idle') return chip('—');
  if (rec.idleSince === null) return chip('不知道');
  const left = rec.idleSince + state.ttlMinutes * 60_000 - at;
  if (left <= 0) return chip('已凉');
  return chip(`热 · 还剩 ${Math.ceil(left / 60_000)} 分`, 'warm');
}

function render({ state, at }) {
  latest = { state, at };
  $('enabled').checked = state.enabled;
  $('ttl').value = String(state.ttlMinutes);

  const status = $('status');
  status.className = 'line muted';
  if (state.lastError) {
    status.textContent = `后台出错:${state.lastError}`;
    status.className = 'line bad';
  } else if (!state.enabled) {
    status.textContent = '保温关着。';
  } else if (state.limit) {
    const what = state.limit.status === 'rejected' ? '用完了' : '快满了';
    status.textContent = `账号额度${what}(${state.limit.window ?? '—'}),${clock(state.limit.until)} 重置:之前不 ping,重置后依次续上报错的会话。`;
    status.className = 'line bad';
  } else if (state.pausedUntil) {
    status.textContent = `暂停到 ${clock(state.pausedUntil)}:${state.pauseReason}`;
    status.className = 'line bad';
  } else if (state.resumeQueue.length) {
    status.textContent = `还有 ${state.resumeQueue.length} 个会话排着队等续上,两个之间隔 2 分钟。`;
  } else {
    const kept = Object.keys(state.keep).length;
    status.textContent = kept ? `在给 ${kept} 个会话保温。` : '还没有要保温的会话:在下面勾上。';
  }
  $('unpause').hidden = !state.pausedUntil;
  window.gugu.setTabBadge(Object.keys(state.keep).length || null).catch((error) => {
    status.textContent += ` · 角标没画上:${error?.message ?? error}`;
  });

  const { pings, pingCost, saved } = state.ledger;
  $('totals').replaceChildren(
    ...[
      ['ping 次数', String(pings)],
      ['ping 花掉(估)', tokens(pingCost)],
      ['省下(估,已扣 ping)', tokens(saved)],
    ].map(([label, value]) => {
      const span = document.createElement('span');
      span.className = 'muted';
      span.append(`${label} `);
      const b = document.createElement('b');
      b.textContent = value;
      span.append(b);
      return span;
    }),
  );

  // 要保温的在前,其余按最近交过轮的先后。
  const rows = Object.entries(state.agents).sort(([ia, a], [ib, b]) =>
    Number(Boolean(state.keep[ib])) - Number(Boolean(state.keep[ia])) ||
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  const shown = showAll ? rows : rows.slice(0, SHOWN);
  $('rows').replaceChildren(
    ...shown.map(([id, rec]) => {
      const tr = document.createElement('tr');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(state.keep[id]);
      box.addEventListener('change', () => tell({ type: 'keep', agentId: id, on: box.checked }));
      const keepTd = document.createElement('td');
      keepTd.append(box);
      const cacheTd = document.createElement('td');
      cacheTd.append(cacheOf(rec, state, Date.now()));
      const last = rec.lastPing ? `${clock(rec.lastPing.at)} ${rec.lastPing.outcome === 'ok' ? '✓' : rec.lastPing.outcome}` : '—';
      tr.append(
        keepTd,
        cell(rec.title ?? id, 'title'),
        cell(rec.status ?? (rec.transport === 'pty' ? '终端(无状态)' : '—')),
        cacheTd,
        cell(rec.contextTokens ? tokens(rec.contextTokens) : '—', 'num'),
        cell(`${rec.totalPings} · ${last}`, 'num'),
        cell(rec.saved ? tokens(rec.saved) : '—', 'num'),
      );
      tr.title = id;
      return tr;
    }),
  );
  const more = $('more');
  more.replaceChildren();
  if (rows.length > SHOWN) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = showAll ? `只看前 ${SHOWN} 个` : `还有 ${rows.length - SHOWN} 个会话,全部显示`;
    button.addEventListener('click', () => {
      showAll = !showAll;
      render(latest);
    });
    more.append(button);
  }
}

$('enabled').addEventListener('change', (event) => tell({ type: 'enabled', on: event.target.checked }));
$('ttl').addEventListener('change', (event) => tell({ type: 'ttl', minutes: Number(event.target.value) }));
$('resume').addEventListener('click', () => tell({ type: 'resume-errored' }));
$('unpause').addEventListener('click', () => tell({ type: 'unpause' }));

window.gugu.onBackgroundMessage((message) => {
  if (message?.type === 'state') render(message);
});
// 「还剩几分」随时间走,不必等后台下一次广播。
setInterval(() => latest && render(latest), 30_000);
tell({ type: 'hello' });
