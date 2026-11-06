import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('supportHelp', {
  'zh-CN': {
    entry: '进入帮助群', title: '官方帮助群', number: '群号 {{number}}',
    visibility: '群内发言对成员可见。', privateGuidance: '账号、计费问题请悄悄话给值班真人；截图、日志请提交反馈。',
    duty: '值班真人：{{name}}', assistants: 'AI 助手：{{names}}', open: '打开群聊', join: '加入群聊', request: '申请加入',
    pending: '等待管理员审核，无需重复申请。', login: '登录后才能加入帮助群。无法登录时，请通过官网求助。',
    working: '正在确认…', retry: '重试', feedback: '提交反馈', website: '官网求助',
    network: '暂时无法确认帮助群状态，请重试或通过官网求助。', changed: '帮助群信息已更新，请核对后再次点击。',
    availability: { available: '', full: '帮助群已满，请提交反馈或通过官网求助。', archived: '帮助群已停用，请提交反馈或通过官网求助。', closed: '帮助群暂时关闭加入，请提交反馈或通过官网求助。', invite_only: '帮助群目前仅限邀请加入，请提交反馈或通过官网求助。' },
  },
  'en-US': {
    entry: 'Enter support group', title: 'Official support group', number: 'Group {{number}}',
    visibility: 'Messages in this group are visible to its members.', privateGuidance: 'Whisper to the duty human about account or billing questions. Send screenshots and logs through feedback.',
    duty: 'Duty human: {{name}}', assistants: 'AI assistants: {{names}}', open: 'Open group', join: 'Join group', request: 'Request to join',
    pending: 'Awaiting administrator approval. No need to request again.', login: 'Sign in to join the support group. If you cannot sign in, use website support.',
    working: 'Checking…', retry: 'Retry', feedback: 'Send feedback', website: 'Website support',
    network: 'Unable to confirm the support group status. Retry or use website support.', changed: 'Support group information changed. Check it before clicking again.',
    availability: { available: '', full: 'The support group is full. Send feedback or use website support.', archived: 'The support group is archived. Send feedback or use website support.', closed: 'Joining is currently closed. Send feedback or use website support.', invite_only: 'The support group is invitation only. Send feedback or use website support.' },
  },
})
