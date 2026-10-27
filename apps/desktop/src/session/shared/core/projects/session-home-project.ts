/** The app-owned project used for sessions created without a selected project. */
export { IMPLICIT_SESSION_HOME_PROJECT_ID, isImplicitSessionHomeProjectId } from '@gugu/core/shared/sessionProject';
/**
 * ❌ 不进翻译目录：这是写进库的 **project 名字**，是持久化数据而不是 chrome。
 * 跟着界面语言变会让同一行记录的名字随语言漂移，也违反「切换语言不改变持久化值」。
 * 渲染层（新建任务时）和主进程（没有渲染层的咕咕 server 收到 agent.create 时）建它用的是同一份。
 */
export const IMPLICIT_SESSION_HOME_PROJECT_NAME = '任务工作区';
