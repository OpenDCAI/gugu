// @@@vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { startAcpAdmissionFixture, stopAcpAdmissionFixture } from '../../support/acp-admission';

afterEach(stopAcpAdmissionFixture);

describe('native compaction admission with real clock intervals', () => {
  it('waits for a durable receipt after 90 seconds of native compaction', async () => {
    const { sent, records, cell } = await startAcpAdmissionFixture('compaction');
    expect(await sent.admission).toMatchObject({ success: true });
    expect(await sent.completion).toMatchObject({ success: true });
    expect(records.filter(record => record.event === 'cancel')).toEqual([]);
    expect(cell.history().committed[0].items).toContainEqual(expect.objectContaining({ kind: 'message', role: 'user', id: expect.stringContaining(':persisted-user'), text: 'body' }));
  }, 130_000);

  it('still cancels a genuinely silent unaccepted prompt with the existing 60-second deadline', async () => {
    const { sent } = await startAcpAdmissionFixture('silence');
    expect(await sent.admission).toMatchObject({ success: false, error: { cause: { code: 'prompt_admission_timeout' } } });
    expect(await sent.completion).toMatchObject({ success: false });
  }, 80_000);

});
