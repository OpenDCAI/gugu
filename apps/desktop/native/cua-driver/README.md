# cua-driver(「电脑控制」)

- 上游版本:0.36.0(发布 tag `cua-driver-rs-v0.36.0`)
- macOS:维护修订 `0.36.0-gugu.1`,从钉住的上游源码加本目录源码补丁构建。包和 sha256 由 `scripts/cua-driver-release.mjs` 钉住,不是上游官方发布包。包含上游捕获修复 #5480,以及并行 AX/截图、owner 取消、定位预算和光标合成修复。
- Windows:继续使用<https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.36.0>的官方二进制。本次原生验收覆盖 macOS,不把 Mac 的通过结果算作 Windows 的验证。
- 许可:MIT(cua 仓根 `LICENSE.md`,cua-driver 的 `Cargo.toml` 写 `license = "MIT"`),第三方声明见 `THIRD_PARTY_NOTICES.md`(原文在 cua 仓 `libs/cua-driver/rust/`)

打包时由 `scripts/build-mac-native.mjs` / `scripts/build-win-native.mjs` 下载、校验 sha256、取出 `cua-driver`(Mac 按架构抽一片)/ `cua-driver.exe`,导出工具清单 `cua-tools.json`,并把这两份许可证以 `CUA-DRIVER-LICENSE.md`、`CUA-DRIVER-THIRD-PARTY-NOTICES.md` 放在二进制旁边。

Mac 维护归档保存在本仓 `assets` prerelease(公开下载,不需要令牌),脚本按文件名下载并用钉住的 sha256 校验。构建机不需要装 gh。读取缓存仍只需指纹校验,不联网。发布客户端不需要这些构建凭据。

## 升级

1. 改 `scripts/cua-driver-release.mjs` 里的 `CUA_DRIVER_VERSION` 与三个 sha256(Mac universal tar.gz、Windows x86_64 / arm64 zip;值在 release 页各资产的 digest,或下载后 `shasum -a 256`)。
2. 换掉本目录的 `LICENSE.md`、`THIRD_PARTY_NOTICES.md` 为新 tag 下的原文,并改上面的版本号。
3. 在 Mac 上跑 `node scripts/build-mac-native.mjs --arch arm64`,核 `cua-tools.json` 的工具变化。

## 重建维护的 macOS 修订

源码、补丁和编译器身份在 `patched-macos.json`;`patches/0.36.0-gugu.1.patch` 是对上游源码的完整差异,保留各项回归测试。正常打包仍下载校验过的二进制,不临时选择上游最新版或改编译产物。

1. 检出 `patched-macos.json` 的 `upstreamRepository` 和精确 `upstreamCommit`,准备它记录的 Rust 编译器、Xcode 及对应 Rust target。
2. 执行 `node scripts/build-cua-driver-patched-macos.mjs --source <cua-checkout> --out <output>/cua-driver-arm64 --arch arm64`,再以 `--arch x64` 构建另一片。脚本校验上游提交、完整源码差异、11个修改文件和编译器,使用锁文件构建;意外改动响亮拒绝。
3. 用 `lipo -create` 合成 universal 的 `cua-driver`,归档它及源码来源说明,上传到本仓 `assets` 预发布（`gh release upload assets <文件> -R OpenDCAI/gugu`，新修订用新文件名，❌ 覆盖已发布的文件），回填归档 sha256。对导出的每片重新核架构、版本、工具清单与源码身份。`--version` 仍为上游0.36.0,维护修订由此目录与归档来源区分。

arm64 维护修订已通过三会话原批次12/12、取消/换代和四预览的实机验收;模式菜单仍有 macOS 的应用 active 前提。跨架构构建与单测不能替代另一台机器的 GUI 验收。
