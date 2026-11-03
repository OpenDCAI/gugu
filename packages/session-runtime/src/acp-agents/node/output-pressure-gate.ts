import type { Readable } from 'node:stream';

/** Keep IPC pressure independent of the ACP web-stream adapter's own pause/resume demand. */
export function outputPressureGate(source: Readable): (blocked: boolean) => void {
  const pause = source.pause.bind(source);
  const resume = source.resume.bind(source);
  let blocked = false;
  let wanted = source.readableFlowing === true;
  source.pause = () => {
    wanted = false;
    return pause();
  };
  source.resume = () => {
    wanted = true;
    return blocked ? source : resume();
  };
  return (next) => {
    blocked = next;
    if (blocked) pause();
    else if (wanted) resume();
  };
}
