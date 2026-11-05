// @@@vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { startAcpAdmissionFixture, stopAcpAdmissionFixture } from '../../support/acp-admission';

afterEach(stopAcpAdmissionFixture);

describe('native compaction termination over a child process stdio', () => {
  it.each(['idle', 'exit'])('fails unaccepted input when compaction ends through %s without completed', async scenario => {
    const { sent } = await startAcpAdmissionFixture(scenario);
    expect(await sent.admission).toMatchObject({ success: false });
    expect(await sent.completion).toMatchObject({ success: false });
  });
});
