import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('mobileTaskFlow', {
  'zh-CN': {
    phoneAgent: '手机 Agent',
    phoneModelDefaultHint: '使用手机 Agent 的默认模型。',
    setupPhone: '设置这台手机',
    noHost: '开启这台手机的任务宿主，或在电脑上登录同一账号。',
    createTask: '新建任务',
    readyToConnect: '可连接',
    connecting: '正在连接',
    pendingCreation: '上次创建尚未确认。发送原任务可继续确认，不会重复创建。',
    originalTask: '查看原任务',
  },
  'en-US': {
    phoneAgent: 'Phone Agent',
    phoneModelDefaultHint: 'Use the phone agent’s default model.',
    setupPhone: 'Set up this phone',
    noHost: 'Enable this phone’s task host, or sign in to Gugu on a computer.',
    createTask: 'New task',
    readyToConnect: 'Ready to connect',
    connecting: 'Connecting',
    pendingCreation: 'The previous creation is not confirmed. Send the original task to confirm it without creating another agent.',
    originalTask: 'View the original task',
  },
})
