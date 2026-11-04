import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('keeps the day-card July 4 date correct across same-probe zones and after returning home', async () => {
  vi.resetModules();
  const { formatDate } = await import('./format');
  let now = Date.UTC(2026, 10, 4, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const options = { month: 'long', day: 'numeric' } as const; // assistant-day-card shortDate
  const actual: string[] = [];
  const expected: string[] = [];
  const visit = (zone: string, elapsed: number) => {
    vi.stubEnv('TZ', zone);
    now += elapsed;
    const date = new Date(2026, 6, 4);
    actual.push(formatDate(date, options, 'en-US'));
    expected.push(new Intl.DateTimeFormat('en-US', options).format(date));
  };
  vi.stubEnv('TZ', 'America/New_York');
  formatDate(new Date(2026, 6, 4), { year: 'numeric' }, 'en-US');
  visit('America/Cancun', 0); // the uncached day-card options must not enter New York's key
  visit('America/Cancun', 6_000);
  visit('America/New_York', 6_000);
  visit('America/New_York', 60_000);
  visit('America/New_York', 3_600_000);
  expect(expected).toEqual(Array(5).fill('July 4'));
  expect(actual).toEqual(expected);
});

it.each(['inherited', 'non-enumerable', 'getter'] as const)('honors %s number options after warming the decimal cache', async (shape) => {
  vi.resetModules();
  const { formatNumber } = await import('./format');
  expect(formatNumber(0.5, {}, 'en-US')).toBe('0.5');
  const options: Intl.NumberFormatOptions = shape === 'inherited'
    ? Object.create({ style: 'percent' })
    : Object.defineProperty({}, 'style', shape === 'getter'
      ? { enumerable: true, get: () => 'percent' }
      : { value: 'percent' });
  expect(formatNumber(0.5, options, 'en-US')).toBe('50%');
});

it.each(['inherited', 'non-enumerable'] as const)('honors %s date options after warming the default cache', async (shape) => {
  vi.resetModules();
  const { formatDate } = await import('./format');
  vi.stubEnv('TZ', 'America/New_York');
  const date = new Date(Date.UTC(2026, 6, 4, 2));
  formatDate(date, {}, 'en-US');
  const options: Intl.DateTimeFormatOptions = shape === 'inherited'
    ? Object.create({ timeZone: 'UTC' })
    : Object.defineProperty({}, 'timeZone', { value: 'UTC' });
  expect(formatDate(date, options, 'en-US')).toBe(new Intl.DateTimeFormat('en-US', options).format(date));
});

it('reads changing getters again rather than freezing their first value in a cache key', async () => {
  vi.resetModules();
  const { formatNumber } = await import('./format');
  let style = 'percent';
  const options = { get style() { return style; } } as Intl.NumberFormatOptions;
  expect(formatNumber(0.5, options, 'en-US')).toBe('50%');
  style = 'decimal';
  expect(formatNumber(0.5, options, 'en-US')).toBe('0.5');
});

it('leaves getter evaluation to Intl instead of reading it once for JSON and again for construction', async () => {
  vi.resetModules();
  const { formatNumber } = await import('./format');
  let reads = 0;
  const options = { get style() { return ++reads === 1 ? 'percent' : 'decimal'; } } as Intl.NumberFormatOptions;
  expect(formatNumber(0.5, options, 'en-US')).toBe('50%');
  expect(reads).toBe(1);
});

it('still throws for invalid numeric options after the JSON-equivalent null option was cached', async () => {
  vi.resetModules();
  const { formatNumber } = await import('./format');
  formatNumber(0.5, { minimumFractionDigits: null } as unknown as Intl.NumberFormatOptions, 'en-US');
  expect(() => formatNumber(0.5, { minimumFractionDigits: NaN }, 'en-US')).toThrow(RangeError);
});

it('does not replace an explicitly invalid time zone with the default', async () => {
  const { formatDate } = await import('./format');
  expect(() => formatDate(Date.now(), { timeZone: null } as unknown as Intl.DateTimeFormatOptions, 'en-US')).toThrow(RangeError);
});

it('reuses the default-zone display formatter while resolving the actual zone on every call', async () => {
  vi.resetModules();
  const { formatDate } = await import('./format');
  const options = { month: 'long', day: 'numeric' } as const;
  formatDate(Date.now(), options, 'en-US');
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const dateTime = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
    return new NativeDateTimeFormat(locale, options);
  });
  for (let i = 0; i < 50; i += 1) formatDate(Date.now() + i, options, 'en-US');
  expect(dateTime).toHaveBeenCalledTimes(50);
  expect(dateTime.mock.calls.every((args) => args.length === 0)).toBe(true);
});
