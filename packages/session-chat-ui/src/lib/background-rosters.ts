/**
 * 后台命令与子智能体两份花名册的纯函数入口:手机看会话(React)从这里取,❌ 拖整个 Solid 聊天库进来。
 * 判据只在这两个文件里各一份,桌面消息列表末尾那一行读的也是它们。
 */
export { collectBackgroundCommandRoster, runningBackgroundTaskIds, type BackgroundCommandEntry } from './background-command-roster';
export { collectSubagentRoster, type SubagentRosterEntry } from './subagent-roster';
export { formatElapsed } from './format-elapsed';
