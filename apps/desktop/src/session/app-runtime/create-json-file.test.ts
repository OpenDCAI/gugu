import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

const chat = '33333333-3333-4333-8333-333333333333';
const setup = () => {
  const create = vi.fn(async (args: unknown) => args);
  const gugu = createGugu(
    { appFiles: { create, watch: vi.fn(async () => undefined) } } as never,
    { files: () => import('./files-entry') as never },
  );
  return { create, files: gugu.files as { create(target: unknown, content: string | object, options?: { contentType?: string }): Promise<unknown> } };
};

describe('files.create JSON names', () => {
  it('stores serialized JSON objects as live JSON, just like an object argument', async () => {
    const { create, files } = setup();
    const data = { question: 'Which?', options: ['A', 'B'], votes: {} };
    await files.create({ chat, name: 'vote.json' }, JSON.stringify(data));
    await files.create({ chat, name: 'object.json' }, data);
    const calls = create.mock.calls.map(([args]) => args);
    expect(calls[0]).toMatchObject({ contentType: 'application/json', content: JSON.stringify(data, null, 2) });
    expect(calls[1]).toMatchObject({ contentType: 'application/json', content: JSON.stringify(data, null, 2) });
  });

  it.each(['{broken', '[1,2]', 'null', '42', '"text"'])('rejects invalid or non-object JSON before creating a file: %s', async content => {
    const { create, files } = setup();
    await expect(files.create({ chat, name: 'vote.json' }, content)).rejects.toMatchObject({ code: 'invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves strings under other names unchanged, including explicit text content types', async () => {
    const { create, files } = setup();
    const content = '{not JSON';
    await files.create({ chat, name: 'notes.md' }, content, { contentType: 'text/plain' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ content, contentType: 'text/plain' }));
  });
});
