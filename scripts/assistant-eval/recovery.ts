/** A later owner message absent from the task record and pre-compact model history. */
export const pendingSource = 'gugu-chat://11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444'
export const pendingMessage = '补充交代：这份材料还须等待法务沈岚确认；当前只可交内部草稿。即便执行者完成，也要把等待对象和未决决定告诉我，未经确认不得对外发布。'

export function pendingNote(session: string, oversized: boolean): string {
  return [
    `执行者：${session}；设备：device:mac。下一步：核对原任务最新结果及下列后补交代。`,
    ...(oversized ? ['归档背景（与本次决定无关）：' + '已核对的旧资料。'.repeat(350)] : []),
    `仍有效约束及等待对象：${pendingMessage}`,
    `原始来源：${pendingSource}`,
  ].join('\n')
}
