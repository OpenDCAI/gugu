import { observer } from 'mobx-react-lite'
import { asMounted, getProjectStore } from '@renderer/features/projects/stores/project-selectors'
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu'
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants'

/**
 * 顶栏那一横排的**项目级**动作组:作用于「当前打开的这个项目」——在哪里打开它、它的设置。
 *
 * owner 定的三层归属(2026-08-19):`项目级 · 会话级 · 工作级`。
 *  · 项目级(这里)与会话级(输出/来源、分享)同住内容列的 header,所以顺序天然是 项目 → 会话;
 *  · 工作级(工作区面板开关)锚窗口右缘,见 titlebar-actions.tsx 的固定簇。
 *
 * 为什么要有这个组件:在它之前,「在哪里打开项目」**只**长在项目设置页那条独有的 40px 横条上,
 * 而主页/会话页用的是零高度浮层——同一个项目里两套顶栏实现,owner 的原话是「一步一景」。
 *
 */
export const ProjectTitleActions = observer(function ProjectTitleActions({
  projectId,
}: {
  projectId: string
}) {
  const store = getProjectStore(projectId)
  const mounted = asMounted(store)
  if (!mounted) return null
  // 「没选仓库」时创建的会话跑在一个**隐藏的**内部项目里(task-home)。它按设计
  // 「must never be rendered as a selectable project」—— 侧栏项目区里也没有它。
  // 所以那种会话页上不该出现任何项目级动作:owner 实机原话
  // 「没有项目的会话页,怎么显示项目设置按钮,按理说没有项目区啊」。
  if (isImplicitSessionHomeProject({ id: projectId })) return null

  return (
    <>
      {/* OpenInMenu 是**两截**(主按钮 + 下拉触发器),各有各的基础样式:真机实测下拉那截
          h=32、top=4,而同排是 28/6 —— 调用点写 className="h-7" 只够得到第一截。
          所以高度交给容器规则(index.css 的 @@@titlebar-action-icons 同族),❌ 别再靠调用点自觉。 */}
      <span data-open-in-row="" className="flex items-center">
        <OpenInMenu
          path={mounted.data.path}
          borderless
        />
      </span>
    </>
  )
})
