/**
 * 一段时长怎么写给人看 —— `48s` / `2m14s` / `1h04m`。
 *
 * owner 2026-09-06:「过程我不关心几步,我关心的是运行多长时间了你懂吧。所以最好有个
 * 时间显示」。
 *
 * ❌ 不用纯秒:子智能体动辄跑几分钟,「315 秒」要在脑子里再除一次。
 * 数字与单位字母两种语言读法一样,所以不进文案表 —— 它是数据的格式,不是一句话。
 *
 * ⚠️ 放在这一层(session-chat-ui/lib)是因为**两侧都要用**:转录里那一行(Solid)报的是
 * 供应商给的总时长,面板里那张卡(React)报的是它已经跑了多久。同一个写法,❌ 别各写一份
 * ——两份迟早在进位或补零上分叉,而那种分叉没人会去查。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}
