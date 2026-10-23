/** Evaluation inputs stay out of the production prompt. These are synthetic, inspectable worlds. */
export type AssistantCase = {
  id: string
  source: string
  prompt: string
  route: 'direct' | 'delegate' | 'blocked' | 'closed'
  device?: 'device:mac' | 'device:phone'
  executorDevices?: readonly string[]
  project?: 'project:launch'
  reuse?: boolean
  offline?: boolean
  requiredFacts?: string[]
  memory?: string
  working?: string
  forbidden?: string[]
  compact?: boolean
  recoveryNote?: 'short' | 'oversize' | 'unreadable'
  recoveredFacts?: string[]
}

/** Twelve common advanced personal-agent themes, and Gugu-specific controls. */
const theme = (item: Omit<AssistantCase, 'source'>): AssistantCase => ({ source: 'theme:advanced-personal-agent', ...item })
const gugu = (item: Omit<AssistantCase, 'source'>): AssistantCase => ({ source: 'gugu:control', ...item })

export const assistantCases: readonly AssistantCase[] = [
  theme({ id: 'daily-brief', route: 'delegate', device: 'device:mac',
    prompt: '把我的 Mac 日历、已连接邮箱和未完成工作汇成今天的安排，标出冲突，只整理不改日程。' }),
  theme({ id: 'inbox-followup', route: 'delegate', device: 'device:mac',
    prompt: '从 Mac 上已连接的邮箱找出还欠回复的邮件，结合相关文档拟回复和跟进清单，先给我检查。' }),
  theme({ id: 'research-monitor', route: 'delegate', executorDevices: ['device:host', 'device:mac'],
    memory: '上轮竞品研究 V1 与本轮 V2 已保存在 {{ROOT}}/inputs/competitors-v1.md、{{ROOT}}/inputs/competitors-v2.md；仅比较导出功能，不推断其他能力。',
    prompt: '请作为一项正式研究任务做一轮竞品研究，把和上次相比的实质变化、原始出处和下一次该查的点写成可回读的研究稿交付。这次不要新增定时。' }),
  theme({ id: 'travel-memory', route: 'delegate', device: 'device:mac', requiredFacts: ['5000', '杭州'],
    memory: '我这次2026年10月24日至26日一人从上海去杭州，住两晚；交通住宿总预算上限5000元，优先高铁。决定于2026-10-20，来源：用户明确提交。',
    prompt: '按我记住的这次出行目的地、日期和预算，用Mac上已连接的浏览器实查交通和住宿，给出具体候选、逐项价格与来源，形成可回读的方案文件，先别下单。' }),
  theme({ id: 'meeting-project', route: 'delegate', device: 'device:mac', project: 'project:launch',
    prompt: '继续「发布准备」项目，读上次讨论和未结事项，准备会前材料和会后跟进模板，交回原项目。' }),
  theme({ id: 'interrupted-project', route: 'delegate', device: 'device:mac', project: 'project:launch', reuse: true,
    requiredFacts: ['周五'], working: '原始需求：gugu-chat://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222\n执行者：session:existing\n项目：project:launch\n设备：device:mac\n仍有效约束：截止周五；只交草稿。\n下一步：核对任务频道最新要求后续做。',
    prompt: '接着做上次发布准备的材料，先核对任务那边我最新说了什么。' }),
  theme({ id: 'content-package', route: 'delegate', device: 'device:mac',
    prompt: '用我 Mac 上的品牌素材做一份完整的活动内容包：资料出处、文案草稿、视觉建议和发布前检查，先给我看。' }),
  theme({ id: 'bugfix-project', route: 'delegate', device: 'device:mac', project: 'project:launch',
    prompt: '「发布准备」项目在 Mac 的工程目录里。复现设置页保存失败，收集证据、修复并验证，给我可以审的改动。' }),
  theme({ id: 'invoice-draft', route: 'delegate', device: 'device:mac',
    prompt: '用我 Mac 上已授权的财务软件和订单文件整理逾期账款，准备催款信草稿，不发送。' }),
  theme({ id: 'household-phone', route: 'delegate', executorDevices: ['device:host', 'device:mac'], requiredFacts: ['device:phone'],
    prompt: '从我手机上最近的学校短信里找下周家长会时间，结合手机日历列出冲突和准备事项，不改日历。' }),
  theme({ id: 'purchase-prepare', route: 'delegate', device: 'device:mac', requiredFacts: ['800'],
    memory: '咖啡机预算上限800元，不接受订阅制。2026-10-20主人确认。',
    prompt: '按我之前定的咖啡机预算，在 Mac 浏览器里比较可买的型号和退换条款，准备购买清单，付款前给我检查。' }),
  theme({ id: 'specialist-handoff', route: 'delegate', device: 'device:mac', project: 'project:launch',
    prompt: '在「发布准备」项目里把市场调研、数据分析和演示文稿制作安排好，最后给我带出处的完整材料包。' }),
  gugu({ id: 'greeting', route: 'direct', prompt: '你好，今天也请多关照。' }),
  gugu({ id: 'simple-answer', route: 'direct', prompt: '用一句话解释什么是缓存。' }),
  gugu({ id: 'explicit-task', route: 'delegate',
    prompt: '把「用一句话解释缓存」也作为一个任务交给任务 Agent，完成后给我结果。' }),
  gugu({ id: 'phone-offline', route: 'blocked', device: 'device:phone', offline: true,
    prompt: '从我手机短信读最新的取件码，告诉我在哪个柜子。' }),
  gugu({ id: 'my-local', route: 'delegate', device: 'device:mac',
    prompt: '我的本地就是账号里的那台 Mac。帮我把本地 Documents 里的材料整理成一份摘要，不要在你的宿主上找。' }),
  gugu({ id: 'unregistered-folder', route: 'delegate', device: 'device:mac',
    prompt: '我 Mac 的 Documents/研究草稿 还没登记项目。先读实际文件做摘要，不用为这一件事新建项目。' }),
  gugu({ id: 'memory-scope', route: 'delegate', device: 'device:mac', requiredFacts: ['无障碍'],
    forbidden: ['无关私人暗号Z9K7'], memory: '演示文稿要照顾无障碍阅读，正文至少18pt。这是主人已确认的排版约定。',
    prompt: '按我的排版约定，用 Mac 上的材料做演示稿。无关的个人信息不要交给执行者。' }),
  gugu({ id: 'closed-after-compact', route: 'closed',
    working: '执行者：session:existing\n项目：project:launch\n下一步：继续准备发布材料。此便笺可能旧了，恢复前查任务。',
    prompt: '上下文压缩后，核对上次发布准备有没有未完成的工作。已经取消的不要继续。' }),
  gugu({ id: 'native-compact-recovery', route: 'delegate', device: 'device:mac', compact: true, requiredFacts: ['周五'],
    prompt: '在我的Mac上整理评审资料，周五截止，只交草稿。安排好执行者后先等结果，我离开一会儿，稍后回来继续。' }),
  ...(['short', 'oversize', 'unreadable'] as const).map(recoveryNote => gugu({
    id: `native-compact-pending-${recoveryNote}`, route: 'delegate', device: 'device:mac', compact: true,
    recoveryNote, requiredFacts: ['周五'], recoveredFacts: ['法务', '沈岚'],
    prompt: '在我的Mac上整理评审资料，周五截止，只交内部草稿。安排好执行者后先等结果，我离开一会儿，稍后回来核对还有哪些交代。',
  })),
]
