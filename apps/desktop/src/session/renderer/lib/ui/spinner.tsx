import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

/** Legacy size names share the product's single loading animation. */
export function Spinner({ className }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  return <LoadingIndicator size="inline" className={className} />;
}
