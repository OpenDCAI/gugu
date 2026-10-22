// @@@touchid-passkey 内置浏览器的 Touch ID 通行密钥。Electron 44 的 `app.configureWebAuthn({ touchID })` 不调用之前,
// 网页里 `isUserVerifyingPlatformAuthenticatorAvailable()` 恒为 false、平台认证器的请求没人接 —— Google 登录
// 选「通行密钥」就卡在那儿。调用的前提是钥匙串组写在本包的 `keychain-access-groups` 权限里,而那项权限要有
// 本团队给这个标识签的描述文件(#7394,electron-builder.cjs 生成主程序权限时把 `<应用 ID>.webauthn` 一并写进去)。
//
// 所以**只认包里真的嵌着描述文件**:没有它(开发版、验收包、ad-hoc 包)就不开 —— 开了也只会在第一次用时
// 被系统拒掉。钥匙串组从描述文件里读本包的应用 ID(`<团队>.<标识>`)再加 `.webauthn`,❌ 按 tier 推:
// 推出来的是「应该是什么」,描述文件里的才是「签进去的是什么」。
//
// 边界(照实):存的是**咕咕自己的**通行密钥,跟着这台 Mac 的安全隔区、不进 iCloud 钥匙串;Safari / Chrome
// 里已有的那批调不出来(苹果只让网站授权过的应用读,Google 不会授权咕咕)。

export interface WebAuthnAccountLike {
  credentialId: string
  name?: string
  displayName?: string
}

/** 描述文件(CMS 包着的 plist,正文是明文)里的应用 ID → 通行密钥用的钥匙串组。读不出返回 null。 */
export function webAuthnKeychainGroup(profile: string | null): string | null {
  if (!profile) return null
  const match = /<key>com\.apple\.application-identifier<\/key>\s*<string>([A-Z0-9]{10}\.[^<\s]+)<\/string>/.exec(profile)
  return match ? `${match[1]}.webauthn` : null
}

/** 给人看的一行:账号名(通常是邮箱)优先,其次显示名,都没有就用凭据 ID 的前几位。 */
export function webAuthnAccountLabel(account: WebAuthnAccountLike): string {
  const name = account.name?.trim()
  const display = account.displayName?.trim()
  if (name && display && display !== name) return `${display}(${name})`
  return name || display || `${account.credentialId.slice(0, 8)}…`
}

export interface AccountChoiceCopy {
  message: string
  detail: string
  cancel: string
}

/**
 * 同一个网站在这台 Mac 上存着多把通行密钥时,让人选一把。`ask` 弹对话框、返回点了第几颗按钮(取消在最后)。
 * 返回选中的凭据 ID;取消、关掉、出错都返回 null —— 调用方据此回调一次,请求以「用户取消」结束,❌ 挂着。
 */
export async function chooseWebAuthnAccount(
  relyingPartyId: string,
  accounts: readonly WebAuthnAccountLike[],
  copy: AccountChoiceCopy,
  ask: (options: { message: string; detail: string; buttons: string[]; cancelId: number }) => Promise<number>,
): Promise<string | null> {
  if (accounts.length === 0) return null
  const buttons = [...accounts.map(webAuthnAccountLabel), copy.cancel]
  const picked = await ask({
    message: copy.message.replace('{site}', relyingPartyId),
    detail: copy.detail.replace('{site}', relyingPartyId),
    buttons,
    cancelId: buttons.length - 1,
  })
  return picked >= 0 && picked < accounts.length ? accounts[picked].credentialId : null
}
