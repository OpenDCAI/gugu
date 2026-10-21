# 咕咕安卓壳（apps/mobile）

Capacitor 8 的安卓壳，界面就是 `apps/desktop` 那一份网页（`pnpm cap:sync` 先构建网页再拷进 `android/`）。
原生插件写在 `android/app/src/main/java/app/gugu/chat/`，都在 `MainActivity` 里于 `super.onCreate` 之前注册；
网页那一侧用 `registerPlugin('<名字>')` 调（样板：`apps/desktop/src/platform/capacitorShare.ts`）。

## 手机当设备（#7199）

云端的助理调这台手机上的单个动作：日历、通讯录、定位、通知与勿扰、闹钟。手机不跑 agent。

| 哪一层 | 在哪 |
|---|---|
| 收发规矩（收到 / 进度 / 结果 / 重推 / 去重 / 授权三查） | `packages/core/src/cloud/deviceActionHost.ts`，与桌面共用一份 |
| 协议合同 | `packages/core/src/shared/deviceActions.ts`（原文在 #7199 的评论里） |
| 动作清单、参数、要不要先问人、在安卓上怎么调 | `apps/desktop/src/mobile/phone-device/phoneActionCatalog.ts` |
| 交给 host 的 provider | `apps/desktop/src/mobile/phone-device/phoneActionProvider.ts` |
| 登记设备行、心跳、订设备 RPC 频道 | `apps/desktop/src/mobile/phone-device/phoneDeviceRuntime.ts`、`phoneDeviceRow.ts` |
| 「我的 → 这台手机」页面 | `apps/desktop/src/mobile/phone-device/PhoneDeviceActionsPage.tsx` |
| 原生动作 | `android/.../GuguPhoneActionsPlugin.java`、`GuguNotificationListener.java` |
| 单测 | `tests/unit/desktop/mobile/phoneDevice7199.test.ts` |

加一个动作的顺序：先在 `GuguPhoneActionsPlugin` 里加 `@PluginMethod`（失败 reject 时带码 `os_permission` / `invalid_args` /
`needs_foreground` / `unavailable` / `failed`），再在 `nativePhoneActions.ts` 补类型，最后在 `phoneActionCatalog.ts` 的
`PHONE_ACTIONS` 里加一条（名字 `<组>.<动作>`，三端同名同义）。新的系统权限要同时写进 `AndroidManifest.xml`、
插件的 `@Permission` 别名，以及 `requirementMet` / `requirementGranted`。

几条已经踩过的：

- device_id ❌ 带冒号。设备 RPC 频道是 `gugu:{device_id}:rpc`，库放行时按冒号取第 2 段。
- 定位用系统的 `LocationManager`，❌ 谷歌的 Fused Location，因为国内手机大多没有谷歌服务。咕咕在后台时，只有定位权限是「始终允许」才取得到。
- 设闹钟 / 倒计时要咕咕在前台，安卓不许后台的 App 拉起时钟。
- 「通知使用权」：装安装包（不经应用商店）的手机，系统可能要先在「应用信息」右上角选「允许受限制的设置」。
- 保活用现成的「后台守着」常驻通知（`apps/desktop/src/mobile/backgroundWatchClaims.ts`，与看管机器共用一条），不做厂商自启动引导。

## 短信、录音和相册（#7504）

三个默认关闭的只读授权组复用上述设备动作通道：`sms.list/get`、`recordings.list/read`、`photos.list/read`。
原生系统读取在 `GuguPhoneDataPlugin.java`，动作参数和系统可用性在 `phoneDataActions.ts`。

- Android 13+ 用 `READ_MEDIA_AUDIO` / `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`；更早的系统用 `READ_EXTERNAL_STORAGE`。
  Android 14+ 支持仅选择照片的授权范围。查询与读取都由 MediaStore 再检查真实系统权限。
- 短信只申请 `READ_SMS`，不发送、不监听、不改已读；这是 installer 必须允许授予的受限权限。
- 媒体只认集合内的数字编号，不接受任意文件路径或 content URI。分页按 `_id` 倒序，用 `next_before_id` 继续。
- 媒体原文件按 96 KiB 一块经设备 RPC 传输；`electron/phone-device-file.ts` 在调用 agent 的宿主上组装，
  返回完整文件路径和 SHA-256。失败删掉本次临时文件；文件内容不作为 base64 文字交给模型。
- 文件接收端需要支持这条传输协议；旧版宿主调用时明确提示更新，原生不会先读出媒体字节。
- 这些权限不提供其他 App 私有目录的读取能力，也不开放麦克风录音。

## 打一个能和正式版、Beta 并排装的测试包

需要 JDK 21 与 Android SDK。在自己的机器上用单独的目录打包：

```bash
# 只在本地改 applicationId 和名字，❌ 提交（仓库只出 production / beta 两种包）
sed -i '' 's|^def guguApplicationId = .*|def guguApplicationId = "app.gugu.chat.localtest"|; s|^def guguAppLabel = .*|def guguAppLabel = "咕咕 测试版"|' apps/mobile/android/app/build.gradle
export JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk ANDROID_SDK_ROOT=/path/to/android-sdk NODE_OPTIONS=--max-old-space-size=6144
GUGU_DB_TARGET=local pnpm android:build   # 连自己的库；.envs/local.env 只需 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
# 产物：apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

这是 debug 签名：同一台机器再打一次可以直接覆盖安装，登录态还在。不设 `GUGU_BUILD_DISTRIBUTION` 时默认为 local，包不会自动更新。

调试：debug 包开着 WebView 调试，`adb forward tcp:9571 localabstract:webview_devtools_remote_<pid>` 之后可以用 CDP 驱动。
