// @@@app-links - shared deploy-time links. The Android download page doubles as the QR landing URL:
export const GUGU_ANDROID_DOWNLOAD_URL =
  'https://download.gugu.nextmind.space/releases/android/latest/gugu-android.apk'

/**
 * #7199「连接更多设备」的下载地址:正式通道 latest(与官网下载菜单同一组,10-15 逐个实测 200)。
 * 只列真出包的平台;没有包的平台不显示连接入口,❌ 编一个地址。
 */
export const GUGU_DOWNLOAD_URLS = {
  macArm64: 'https://download.gugu.nextmind.space/releases/mac/latest/gugu-mac-arm64.dmg',
  macX64: 'https://download.gugu.nextmind.space/releases/mac/latest/gugu-mac-x64.dmg',
  windowsX64: 'https://download.gugu.nextmind.space/releases/windows/latest/gugu-windows-x64.exe',
  linuxX64: 'https://download.gugu.nextmind.space/releases/linux/latest/gugu-linux-x86_64.AppImage',
  android: GUGU_ANDROID_DOWNLOAD_URL,
} as const

/**
 * 顾客自助面板:买会员、买加量包、兑礼品码、看购买记录与申请退款,全在这里。
 *
 * app 内**不重复这些界面** —— 档位与价格是营销内容,烧进桌面包就意味着调一次价要发一次版,
 * 而已装的旧版本会一直对着用户报过期价格。网页改完刷新即生效,那里是唯一真值。
 */
export const GUGU_BILLING_URL = 'https://gugu.nextmind.space/dashboard/'

/**
 * 去网页面板(开会员、续费)。三端同一条路:Electron 里 window.open 被主窗口的 setWindowOpenHandler
 * 交给系统浏览器,网页版是用户自己浏览器里的新标签,手机交给系统浏览器。
 * ❌ 任务页那条 `rpc.app.openExternal`:网页版上它由服务器那台机器执行,开不到用户眼前(#7056)。
 */
export function openBillingPage(): void {
  window.open(GUGU_BILLING_URL, '_blank', 'noopener,noreferrer')
}
