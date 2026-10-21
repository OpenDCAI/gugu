import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_INLINE_PROMPT_CHARS,
  spillLargePrompt,
} from './spill-large-prompt';

describe('spillLargePrompt', () => {
  it('returns the prompt unchanged when exactly at the threshold', async () => {
    const writeContextFile = vi.fn();
    const prompt = 'x'.repeat(MAX_INLINE_PROMPT_CHARS);

    const result = await spillLargePrompt(prompt, {
      createTempDir: async () => '/tmp/gugu-prompt-xyz',
      writeContextFile,
    });

    expect(result.prompt).toBe(prompt);
    expect(writeContextFile).not.toHaveBeenCalled();
  });

  it('cleans up the temp dir and falls back to inline when writing fails', async () => {
    const prompt = 'z'.repeat(MAX_INLINE_PROMPT_CHARS + 1);
    const onError = vi.fn();
    const removeTempDir = vi.fn(async () => {});

    const result = await spillLargePrompt(prompt, {
      createTempDir: async () => '/tmp/gugu-prompt-fail',
      writeContextFile: async () => {
        throw new Error('disk full');
      },
      removeTempDir,
      onError,
    });

    expect(result.prompt).toBe(prompt);
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/gugu-prompt-fail');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toBe(prompt.length);
  });

  it('writes a readable file on disk and removes it on cleanup', async () => {
    const prompt = `# Context\n${'paragraph '.repeat(2000)}`;

    const result = await spillLargePrompt(prompt);

    const match = result.prompt.match(/Read the file at (.+task-context\.md) and/);
    expect(match).not.toBeNull();
    const filePath = match![1];
    await expect(readFile(filePath, 'utf8')).resolves.toBe(prompt);

    await result.cleanup();
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });
});
