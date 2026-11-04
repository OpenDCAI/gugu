// Shared by the local server and self-contained SSH uninstall. Runtime services
// are supplied by the caller, so both use the same ownership/error semantics.
function createAccountLockProbe({ fs, spawnSync, platform, kill }) {
  // A sessionless account may still own a writable lock after migration to
  // retired. Enumerate every real account directory inside the deletion scope.
  function directories(home) {
    const dirs = [`${home}/account`];
    for (const name of ['accounts', 'retired']) {
      const root = `${home}/${name}`;
      try {
        if (!fs.lstatSync(root).isDirectory()) throw new Error(`Cannot verify account directory root ${root}`);
        dirs.push(...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
          .map(entry => `${root}/${entry.name}`));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return dirs.filter(dir => {
      try { return fs.lstatSync(dir).isDirectory(); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }).map(dir => `${dir}/data`);
  }
  const unknown = (pid, cause) => Object.assign(new Error(`Cannot verify account lock ownership for PID ${pid}`, { cause }), { code: 'ACCOUNT_LOCK_UNVERIFIABLE' });
  function alive(pid) {
    try { kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw unknown(pid, error);
    }
    if (platform !== 'linux') return true;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3));
    } catch (error) {
      if (error.code === 'ENOENT') {
        // procfs can hide a live process. Only a second ESRCH proves it exited.
        try { kill(pid, 0); } catch (again) {
          if (again.code === 'ESRCH') return false;
          throw unknown(pid, again);
        }
      }
      throw unknown(pid, error);
    }
  }
  function snapshot(file) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error('Account lock is not a regular file');
      return { pid: Number(fs.readFileSync(fd, 'utf8').trim()), dev: stat.dev, ino: stat.ino };
    } finally { fs.closeSync(fd); }
  }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  function owns(pid, file, expected = fs.statSync(file, { bigint: true })) {
    if (platform === 'linux') {
      let descriptors;
      try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch (error) {
        if (error.code === 'ENOENT' && !alive(pid)) return false;
        throw unknown(pid, error);
      }
      for (const fd of descriptors) {
        try {
          const actual = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
          if (!same(actual, expected)) continue;
          const flags = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^flags:\s+([0-7]+)$/m)?.[1];
          if (!flags) throw unknown(pid, 'Missing FD access flags');
          if ((Number.parseInt(flags, 8) & 3) !== 0) return true;
        } catch (error) { if (error.code !== 'ENOENT') throw unknown(pid, error); }
      }
      return false;
    }
    if (platform !== 'darwin') throw new Error('Unsupported account lock platform');
    // A file filter hides ferr/NOFD records. Inspect the complete PID instead.
    const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-F', 'faDitn'], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.signal || result.status !== 0 || result.stderr.trim()) {
      if (!alive(pid)) return false;
      throw unknown(pid, result.error ?? result.stderr);
    }
    let record = {}, found = false, incomplete = false, processSeen = false, descriptorsSeen = false;
    function finish() {
      if (!record.fd || ['cwd', 'txt', 'mem'].includes(record.fd)) return;
      if (!/^\d+$/.test(record.fd) || !record.type || (!record.name?.startsWith('/') && /error|unknown|denied|permitted/i.test(record.name ?? ''))) { incomplete = true; return; }
      descriptorsSeen = true;
      if (!['REG', 'DIR'].includes(record.type)) {
        if (!['CHR', 'BLK', 'FIFO', 'PIPE', 'IPv4', 'IPv6', 'unix', 'KQUEUE', 'PSXSEM', 'PSXSHM', 'NPOLICY', 'systm'].includes(record.type)) incomplete = true;
        return;
      }
      if (!record.device || !record.inode) { incomplete = true; return; }
      if (BigInt(record.device) !== expected.dev || BigInt(record.inode) !== expected.ino) return;
      if (!['r', 'w', 'u'].includes(record.access)) { incomplete = true; return; }
      if (record.access !== 'r') found = true;
    }
    for (const field of result.stdout.split('\n')) {
      if (field.startsWith('p')) processSeen = field.slice(1) === String(pid);
      else if (field.startsWith('f')) { finish(); record = { fd: field.slice(1) }; }
      else if (field.startsWith('a')) record.access = field.slice(1);
      else if (field.startsWith('D')) record.device = field.slice(1);
      else if (field.startsWith('i')) record.inode = field.slice(1);
      else if (field.startsWith('t')) record.type = field.slice(1);
      else if (field.startsWith('n')) record.name = field.slice(1);
    }
    finish();
    if (found && processSeen) return true;
    if (!processSeen || incomplete || !descriptorsSeen) throw unknown(pid, 'Incomplete process FD inspection');
    return false;
  }
  function holder(dataDir, deps = {}) {
    const file = `${dataDir}/server.lock`;
    const text = deps.read?.(file);
    const saved = deps.read ? (text == null ? null : { pid: Number(text.trim()) }) : snapshot(file);
    if (!saved) return null;
    // A legacy creator can be holding its writable FD before publishing its
    // PID. An empty/corrupt record is not proof that the lock is abandoned.
    if (!Number.isInteger(saved.pid) || saved.pid <= 0) throw unknown(saved.pid, 'Unpublished or invalid account PID');
    if (!(deps.alive ?? alive)(saved.pid)) return null;
    const owned = deps.ownsLock ? deps.ownsLock(saved.pid, file) : owns(saved.pid, file, saved);
    if (!deps.read) {
      let current;
      try { current = fs.statSync(file, { bigint: true }); } catch (error) { throw unknown(saved.pid, error); }
      if (!same(saved, current)) throw unknown(saved.pid, 'Lock inode changed during inspection');
    }
    return owned ? saved.pid : null;
  }
  return { directories, alive, snapshot, same, owns, holder };
}
module.exports = { createAccountLockProbe };
