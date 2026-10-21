import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.gugu.chat',
  appName: '咕咕',
  webDir: 'dist-phone',
  android: {
    path: 'apps/mobile/android',
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    App: { disableBackButtonHandler: true },
    // 状态栏小图标 = 单色字形(scripts/gen-tray-icons.py 与托盘图标同源生成);不配会退回安卓自带的「i」。着色用 App 自己的 colorAccent,与「后台守着」那条常驻通知同色。
    LocalNotifications: { smallIcon: 'ic_stat_gugu', iconColor: '#07C160' },
  },
}

export default config
