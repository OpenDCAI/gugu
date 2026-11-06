import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('connections',{
  'zh-CN': { device: '设备',allDevices: '全部设备',chooseDevice: '请先选择一台设备，再连接此应用。',platform: '平台',accounts: '账号',
    operations: '待完成的操作',pending: '等待处理',started: '正在处理',failed: '操作未完成',unknown: '结果待核对，请核实后再操作。',
    retry: '重试',readFailed: '暂时无法读取连接，请重试。',notReady: '连接资料尚未准备好，已有凭据仍保留。',
    changed: '连接已在其他地方变化，请重新读取后再操作。',quiescing: '连接正在切换，暂时无法开始新操作。',access: '无法访问这份连接，请核对登录账号和设备。',
    unavailable: '暂时无法完成操作，已保存的请求仍保留。',disconnect: '断开连接',disconnectTitle: '断开 {{name}}？',
    disconnectBody: '此账号将从{{where}}断开。',operation: '连接操作',defaultAccount: '默认账号',makeDefault: '设为默认',
    onDevice: '此账号保存在 {{device}}',onPlatform: '凭据由平台保管，可在你的设备间使用。' },
  'en-US': { device: 'Device',allDevices: 'All devices',chooseDevice: 'Choose a device before connecting this app.',platform: 'Platform',accounts: 'Accounts',
    operations: 'Unfinished operations',pending: 'Waiting to be processed',started: 'Processing',failed: 'Operation failed',unknown: 'The outcome needs review. Verify it before continuing.',
    retry: 'Retry',readFailed: 'Connections could not be read. Please retry.',notReady: 'Connection data is not ready. Existing credentials are retained.',
    changed: 'This connection changed elsewhere. Refresh it before continuing.',quiescing: 'Connections are switching. New operations are temporarily paused.',access: 'This connection is not accessible. Check your account and device.',
    unavailable: 'The operation could not finish. Its saved request is retained.',disconnect: 'Disconnect',disconnectTitle: 'Disconnect {{name}}?',
    disconnectBody: 'This account will be disconnected from {{where}}.',operation: 'Connection operation',defaultAccount: 'Default account',makeDefault: 'Make default',
    onDevice: 'This account is stored on {{device}}',onPlatform: 'The platform keeps this credential for use across your devices.' },
})

/** Never put SQL/provider diagnostics or internal resource keys in the page. */
export function connectionFailure(error: unknown,t: (key: string) => string) {
  const code = (error as { code?: string } | null)?.code
  return t(code === 'not-ready' || code === '55000' ? 'notReady'
    : code === 'quiescing' ? 'quiescing' : code === 'PT409' || code === 'intent-changed' || code === 'identity-changed' || code === 'route-changed' ? 'changed'
      : ['signed-out','account-changed','42501'].includes(code ?? '') ? 'access'
        : code === 'device-required' ? 'chooseDevice' : 'unavailable')
}
