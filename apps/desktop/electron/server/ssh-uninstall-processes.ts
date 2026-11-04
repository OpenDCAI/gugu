import accountLockProbeSource from './server-account-lock-probe.cjs?raw'

/** Runs with the installation's bundled Node, including when its server package
 * predates this fix. Do not delegate PID signaling to that older package's stop. */
export function verifiedUninstallProcessesScript(): string {
  return [
    'need_node=',
    'for f in "$H/data/keeper.pid" "$H/data/server.lock" "$H/account/data/server.lock" "$H"/accounts/*/data/server.lock "$H"/retired/*/data/server.lock; do [ -L "${f%/data/server.lock}" ] && continue; [ ! -f "$f" ] || need_node=1; done',
    'if [ -n "$need_node" ]; then',
    '  N="$H/current/node/bin/node"',
    '  if [ ! -x "$N" ]; then echo "无法核实运行进程:安装内的 Node 不可用" >&2; exit 1; fi',
    '  "$N" - "$H" <<\'__GUGU_VERIFIED_PROCESS_STOP__\'',
    'const module = { exports: {} };',
    accountLockProbeSource,
    String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const probe = module.exports.createAccountLockProbe({ fs, spawnSync: cp.spawnSync, platform: process.platform, kill: process.kill.bind(process) });
const home = process.argv[2], homes = [...new Set([home, fs.realpathSync(home)])];
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function controlOwned(pid, kind) {
  if (!probe.alive(pid)) return false;
  let args, command;
  if (process.platform === 'linux') {
    try { args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean); }
    catch (error) { if (!probe.alive(pid)) return false; throw error; }
    command = args.join(' ');
  } else {
    const result = cp.spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      if (!probe.alive(pid)) return false;
      throw new Error('Cannot verify installation control process ' + pid);
    }
    command = result.stdout.trim();
  }
  if (kind === 'keeper') {
    if (!command.includes('# gugu-server-keeper')) return false;
    if (homes.some(h => command.includes('H=' + quote(h) + '; D=' + quote(path.join(h, 'data')) + '; E='))) return true;
    if (command.includes('; D=') && command.includes('; E=')) return false;
    throw new Error('Cannot verify keeper installation ' + pid);
  }
  if (args) {
    const script = args[1];
    if (!script || !script.endsWith('/app/dist-electron/server.js') || (args[2] && args[2] !== 'run')) return false;
    return homes.some(h => script.startsWith(h + '/versions/') || script.startsWith(h + '/current/'));
  }
  if (!command.includes('server.js')) return false;
  const boundary = command.lastIndexOf('/node/bin/node ');
  if (boundary >= 0) {
    const executable = command.slice(0, boundary + '/node/bin/node'.length);
    const tail = command.slice(boundary + '/node/bin/node '.length);
    const script = tail.endsWith(' run') ? tail.slice(0, -4) : tail;
    if (script.endsWith('/app/dist-electron/server.js') && homes.some(h =>
      (executable.startsWith(h + '/versions/') || executable.startsWith(h + '/current/')) &&
      (script.startsWith(h + '/versions/') || script.startsWith(h + '/current/')))) return true;
  }
  if (!homes.some(h => command.includes(h + '/'))) return false;
  throw new Error('Cannot verify supervisor installation ' + pid);
}
function controls() {
  return [['keeper', path.join(home, 'data/keeper.pid')], ['supervisor', path.join(home, 'data/server.lock')]].flatMap(([kind, file]) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8').trim(); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Cannot verify ' + kind + ' PID file ' + file, { cause: error });
    }
    const pid = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid) || pid > 2147483647) {
      throw new Error('Cannot verify ' + kind + ' PID: empty or invalid PID file ' + file);
    }
    return [{ kind, file, pid }];
  });
}
const accountDirs = () => probe.directories(home);
function signal(pid, value) { try { process.kill(pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
function signalControls(value) {
  for (const item of controls()) if (controlOwned(item.pid, item.kind)) signal(item.pid, value);
}
function signalAccounts(value) {
  for (const dir of accountDirs()) { const pid = probe.holder(dir); if (pid !== null && probe.holder(dir) === pid) signal(pid, value); }
}
(async () => {
  // Validate every live candidate before changing this installation's state.
  for (const item of controls()) controlOwned(item.pid, item.kind);
  for (const dir of accountDirs()) probe.holder(dir);
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data/stopped'), new Date().toISOString());
  signalControls('SIGTERM'); signalAccounts('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 3000));
  signalControls('SIGKILL'); signalAccounts('SIGKILL');
})().catch(error => { console.error(String(error)); process.exitCode = 1; });
`,
    '__GUGU_VERIFIED_PROCESS_STOP__',
    '  verified_stop_code=$?',
    '  [ "$verified_stop_code" = 0 ] || exit "$verified_stop_code"',
    'fi',
  ].join('\n')
}
