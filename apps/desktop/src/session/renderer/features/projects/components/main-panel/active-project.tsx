import { observer } from 'mobx-react-lite';
import { ProjectHome } from './project-home';

/**
 * @@@sessionpage layout — the project main area is the home
 * (product spec 项目首页). The old Tasks/PRs/Settings nav is gone: tasks live
 * in the app sidebar, the PR top-level entry was cut (owner: 不留), and the project
 * settings sub-view was retired 2026-09-10 (owner: 先不展示项目设置) — so the project
 * route now renders exactly one thing.
 */
export const ActiveProject = observer(function ActiveProject() {
  return <ProjectHome />;
});
