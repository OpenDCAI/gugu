/**
 * @@@factory-default-autonomy — 新建任务 / 新建会话 composer 的**出厂默认**自主权。
 *
 * owner 2026-08-27 定:出厂默认 = 完全访问(full-access)。这条只定「用户没表过态时给什么」,
 * 它**不缩小选择面**:四档(plan / read-only / edit / full-access)一档不删,composer 的档位
 * 下拉照旧全摆,用户随时可改。用户表过态的一律优先:设置里改过(override)、或上一次成功启动
 * 留下的记录(见 [[last-started-session-configuration]]),都盖过这个值。
 *
 * 为什么它必须只有这一处字面量:此前 `false` 在四处各写了一遍 —— settings registry 的出厂值、
 * renderer 载入未完成时的兜底、seeding hook 的参数默认、设置页「恢复默认」按钮的文案。
 * 改一处而漏另几处,「出厂默认」就会在不同渲染时刻是两个值,而设置页还会把它读错的那个
 * 当成真相显示给用户。
 *
 * 类型显式写成 `boolean` 而不是让它收窄成字面量 `true`:下游要拿它做三元(「恢复默认」按钮的
 * 开/关文案),收窄成 `true` 会让那个三元变成恒真的死分支,反手把「文案跟着默认值走」这件事
 * 又变回硬编码。
 */
export const DEFAULT_SESSION_AUTO_APPROVE: boolean = true;
