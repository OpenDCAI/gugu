/** Historical codex ACP wire audit; native history has its own record-source fixtures. */

import {
  agentStateSchema,
  sessionPlansSchema,
  sessionConfigStateSchema,
  sessionUsageSchema,
  transcriptTurnSchema,
} from '@gugu/session-core/acp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { driveParser, loadFixture } from '../../../../tooling/fixtures/acp/drive-parser';
import { entitySnapshot } from '../../../../tooling/fixtures/acp/entity-snapshot';

const fixture = loadFixture(new URL('./fixtures/acp-transcript.json', import.meta.url));

function createParser() {
  return driveParser(fixture);
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

describe('Codex ACP fixture parsing', () => {
  it('transcript', () => {
    const parser = createParser();
    expect(entitySnapshot({ committed: parser.history, active: parser.activeTurn })).toMatchSnapshot();
  });

  it('config', () => {
    const parser = createParser();
    expect(parser.config).toMatchSnapshot();
  });

  it('usage', () => {
    const parser = createParser();
    expect(parser.usage).toMatchSnapshot();
  });

  it('title', () => {
    const parser = createParser();
    expect(parser.title).toMatchSnapshot();
  });

  it('plan', () => {
    const parser = createParser();
    expect(parser.plan).toMatchSnapshot();
  });

  it('agents', () => {
    const parser = createParser();
    expect(parser.agents).toMatchSnapshot();
  });

  it('validates public model schemas', () => {
    const parser = createParser();
    expect(() => transcriptTurnSchema.array().parse(parser.history)).not.toThrow();
    expect(() => transcriptTurnSchema.nullable().parse(parser.activeTurn)).not.toThrow();
    expect(() => sessionConfigStateSchema.parse(parser.config)).not.toThrow();
    expect(() => sessionUsageSchema.nullable().parse(parser.usage)).not.toThrow();
    expect(() => sessionPlansSchema.nullable().parse(parser.plan)).not.toThrow();
    expect(() => agentStateSchema.array().parse(parser.agents)).not.toThrow();
  });
});
