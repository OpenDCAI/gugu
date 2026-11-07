import lockfile from 'proper-lockfile';

// signal-exit 3 (loaded by proper-lockfile) installs SIGTRAP. Returning from a
// libuv handler for a synchronous hardware trap re-executes the fault forever;
// JS cannot safely recover. Keep its exit/SIGINT/SIGTERM lock cleanup intact.
// There is no signal exclusion option in proper-lockfile 4 / signal-exit 3.
for (const signal of ['SIGTRAP', 'SIGILL', 'SIGBUS', 'SIGFPE', 'SIGSEGV'] as const) {
  process.removeAllListeners(signal);
}

export default lockfile;
