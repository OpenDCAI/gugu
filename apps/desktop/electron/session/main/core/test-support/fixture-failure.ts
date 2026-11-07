function reportFailure(phase: string, error: unknown): void {
  process.stderr.write('REAL_ELECTRON_FIXTURE_FAILURE=' + JSON.stringify({ phase,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined }) + '\n');
}

/** Record the original error while the parent can still read it, before cleanup. */
export async function withFixtureCleanup<T>(phase: () => string, body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failed = false, primary: unknown, value!: T;
  try { value = await body(); }
  catch (error) { failed = true; primary = error; reportFailure(phase(), error); }
  try { await cleanup(); }
  catch (error) {
    reportFailure('cleanup', error);
    if (failed) throw new AggregateError([primary, error], 'Fixture failed and cleanup also failed', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  return value;
}
