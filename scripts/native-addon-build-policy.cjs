const HIDDEN_VISIBILITY_FLAG = '-fvisibility=hidden'

// #4401 —— node-gyp 自带的 addon.gypi 对**每一个**原生插件都无条件注入
// `-DV8_DEPRECATION_WARNINGS=1`（"Warn when using deprecated V8 APIs"，addon 作者管不了这个文件）。
// 这只是打开 v8config.h 里 `V8_DEPRECATED(msg)` 宏,让它从空展开变成 `[[deprecated(msg)]]`——
// 本该只是多几行编译警告。但 Electron 44(V8 新到把 `String::Value` 标了 deprecated)撞上
// GCC 12.2 一个前端 bug:`class V8_DEPRECATED(msg) V8_EXPORT Value { ... }` 展开后变成
// `class [[deprecated(msg)]] __attribute__((visibility(...))) Value {`——C++11 标准属性紧接着
// GNU 属性写在 class-head 上,GCC 12.2 解析不动,报 `expected identifier before '__attribute__'`
// 而不是普通 deprecated 警告(GCC 13 起已修,clang 从来没这问题,macOS 构建因此从没红过)。
// 用 `-U` 在同一条编译命令里于 node-gyp 的 `-D` **之后**撤销这个宏(GCC/Clang 对 -D/-U 按命令行
// 出现顺序生效)——直接掐掉从没人要的诊断开关,不用碰 GCC 版本或 Debian 基础镜像(那会抬高
// AppImage 产物的 glibc 地板,把存量 Ubuntu 22.04 用户挡在外面)。实测(mac1,Debian 12/GCC 12.2
// 容器):不加此 flag,`pnpm exec electron-rebuild -f --only better-sqlite3,node-pty` 在
// better-sqlite3 上必现这条编译错误;加上后两个模块都 Rebuild Complete。
const UNDEF_V8_DEPRECATION_WARNINGS_FLAG = '-UV8_DEPRECATION_WARNINGS'

function createNativeAddonBuildEnv(platform, env = process.env) {
  if (platform === 'win32') return env

  return {
    ...env,
    CXXFLAGS: [env.CXXFLAGS, HIDDEN_VISIBILITY_FLAG, UNDEF_V8_DEPRECATION_WARNINGS_FLAG]
      .filter(Boolean)
      .join(' '),
  }
}

module.exports = {
  HIDDEN_VISIBILITY_FLAG,
  UNDEF_V8_DEPRECATION_WARNINGS_FLAG,
  createNativeAddonBuildEnv,
}
