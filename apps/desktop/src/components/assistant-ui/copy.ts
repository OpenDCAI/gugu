import { useTranslation } from 'react-i18next'

/**
 * 拷进来的 assistant-ui 组件里所有**给人看的文字**的唯一出处。
 *
 * 为什么集中在这里，而不是在各个组件里散写 `t('…')`：
 *   · `components/assistant-ui/` 那批文件是官方 registry 原样拷来的，上游改了要能重新拷一遍再合。
 *     每个文案位点只换成 `c.send` 这样的一个标识符，diff 最小，也一眼看得出哪些是咕咕改过的。
 *   · 官方模板里的文案原本是英文字面量。上一版改成中文字面量 = 把「只有中文」焊进了组件，
 *     而这个产品有 en-US 目录 —— 英文用户会看到中文界面。
 *
 * ⚠️ 这是一个 hook（内部用 `useTranslation`），只能在组件里调。模块级常量要文案的，
 * 把常量改成接收 `c` 的函数，❌ 别在模块顶层调它。
 */
export function useAuiCopy() {
  const { t } = useTranslation('main')
  return {
    // —— 线程 ——
    scrollToBottom: t('assistantUi.thread.scrollToBottom'),
    emptyTitle: t('assistantUi.thread.emptyTitle'),
    emptyHint: t('assistantUi.thread.emptyHint'),
    placeholder: t('assistantUi.thread.placeholder'),
    composerLabel: t('assistantUi.thread.composerLabel'),
    dictate: t('assistantUi.thread.dictate'),
    dictateStart: t('assistantUi.thread.dictateStart'),
    dictateStop: t('assistantUi.thread.dictateStop'),
    send: t('assistantUi.thread.send'),
    stop: t('assistantUi.thread.stop'),
    running: t('assistantUi.thread.running'),
    copy: t('assistantUi.thread.copy'),
    more: t('assistantUi.thread.more'),
    exportMarkdown: t('assistantUi.thread.exportMarkdown'),

    // —— 附件 ——
    attachmentAdd: t('assistantUi.attachment.add'),

    // —— 工具卡 ——
    toolCancelledPrefix: t('assistantUi.tool.cancelledPrefix'),
    toolCancelReason: t('assistantUi.tool.cancelReason'),
    toolErrorHeader: t('assistantUi.tool.errorHeader'),
    approved: t('assistantUi.tool.approved'),
    denied: t('assistantUi.tool.denied'),
    allow: t('assistantUi.tool.allow'),
    deny: t('assistantUi.tool.deny'),
    allowOnce: t('assistantUi.tool.allowOnce'),
    allowAlways: t('assistantUi.tool.allowAlways'),
    rejectOnce: t('assistantUi.tool.rejectOnce'),
    rejectAlways: t('assistantUi.tool.rejectAlways'),
    answerPlaceholder: t('assistantUi.tool.answerPlaceholder'),
    notePlaceholder: t('assistantUi.tool.notePlaceholder'),
    answerLabel: t('assistantUi.tool.answerLabel'),
    noteLabel: t('assistantUi.tool.noteLabel'),
  }
}

export type AuiCopy = ReturnType<typeof useAuiCopy>

/** 工具分组折叠行的「N 次工具调用」。数字进插值，❌ 不用字符串拼 —— 各语言语序不同。 */
export function useToolGroupLabel(count: number): string {
  const { t } = useTranslation('main')
  return t('assistantUi.tool.groupCount', { count })
}

/** 审批选项的兜底名字：provider 自己给了 label 就用它的，没给才落到这套。 */
export function approvalOptionLabels(c: AuiCopy): Record<string, string> {
  return {
    'allow-once': c.allowOnce,
    'allow-always': c.allowAlways,
    'reject-once': c.rejectOnce,
    'reject-always': c.rejectAlways,
  }
}
