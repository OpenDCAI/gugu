import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '@/i18n/useLocale';
import { formatRelativeTimeParts } from '@/i18n/format';

type RelativeTimeProps = {
  value: string | number | Date;
  className?: string;
  /** Abbreviated local units. `ago` includes the direction suffix. */
  compact?: boolean;
  ago?: boolean;
};

function parseTimestamp(input: string | number | Date): Date | null {
  if (input instanceof Date) return input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = String(input).trim();
  if (!raw) return null;
  const normalized = raw.includes('Z') || raw.includes('+') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function RelativeTime({ value, className, compact, ago }: RelativeTimeProps) {
  const { resolvedLocale } = useLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const date = useMemo(() => parseTimestamp(value), [value]);
  if (!date) return <span className={className}>—</span>;
  const parts = formatRelativeTimeParts(date, compact
    ? { mode: 'compact', addSuffix: Boolean(ago), locale: resolvedLocale }
    : { mode: 'strict', locale: resolvedLocale });
  if (!parts) return <span className={className}>—</span>;
  return (
    <time className={className} dateTime={date.toISOString()}>
      {parts.map((part, index) => compact && part.type === 'suffix'
        ? <span key={index} className="text-foreground-muted">{part.value}</span>
        : part.value)}
    </time>
  );
}
