/**
 * 区分「Electron 二进制自己起不来」与「原生模块 ABI 不对」。
 *
 * 这两种失败都表现为 execFileSync 抛错,但性质相反:前者是环境缺依赖(本闸无判据可言),
 * 后者正是本闸要抓的那个 bug。混为一谈的代价两个方向都有 ——
 * 当成 ABI 报错会让人白去重编模块;当成环境跳过会把真的 ABI 错配放过去。
 *
 * 判据取二进制**根本没跑起来**的信号,而不是「报错里有没有某个词」:
 *   - exit 127 = 命令无法执行(动态链接器/loader 层),不是程序自己 exit 的码
 *   - 动态链接器在各平台的原话:glibc `error while loading shared libraries`、
 *     macOS dyld `Library not loaded`、musl `Error loading shared library`
 * ABI 不一致时 Electron 是**跑起来了**的,退出码非 127,报的是 NODE_MODULE_VERSION。
 */
const LOADER_FAILURE_MARKERS = [
  'error while loading shared libraries', // glibc ld.so
  'Error loading shared library', // musl ld
  'Library not loaded', // macOS dyld
  'cannot open shared object file', // glibc 的后半句,单独出现过
]

export function isElectronUnlaunchable(status, detail) {
  const text = String(detail ?? '')
  // ABI 报错一票否决:那说明进程真的跑起来并加载到了原生模块,不是启动失败。
  if (text.includes('NODE_MODULE_VERSION')) return false
  const loaderFailed = LOADER_FAILURE_MARKERS.some((marker) => text.includes(marker))
  return status === 127 && loaderFailed
}
