import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitRepositoryFetchService } from './fetch-service';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

// The background loop forks git every 2 minutes; a repository with no remote has nothing to fetch, so it must not.
function target(remotes: { name: string; url: string }[]) {
  return {
    getRemotes: vi.fn(async () => remotes),
    fetch: vi.fn(async () => ({ success: true as const, data: { sequences: {} } })),
  };
}

describe('GitRepositoryFetchService background loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not fetch a repository with no remote, at start or on any tick', async () => {
    const repo = target([]);
    const service = new GitRepositoryFetchService(repo as never, async () => 'origin');
    service.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(repo.fetch).not.toHaveBeenCalled();
    service.stop();
  });

  it('fetches a repository with a remote at start and every interval', async () => {
    const repo = target([{ name: 'origin', url: 'https://example.invalid/repo.git' }]);
    const service = new GitRepositoryFetchService(repo as never, async () => 'origin');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(repo.fetch).toHaveBeenCalledTimes(3);
    expect(repo.fetch).toHaveBeenCalledWith('origin');
    service.stop();
  });

  it('a remote added later is fetched on the next tick; an explicit fetch() runs regardless', async () => {
    const remotes: { name: string; url: string }[] = [];
    const repo = target(remotes);
    const service = new GitRepositoryFetchService(repo as never, async () => 'origin');
    service.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(repo.fetch).not.toHaveBeenCalled();
    await service.fetch();
    expect(repo.fetch).toHaveBeenCalledTimes(1);
    remotes.push({ name: 'origin', url: 'https://example.invalid/repo.git' });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(repo.fetch).toHaveBeenCalledTimes(2);
    service.stop();
  });
});
