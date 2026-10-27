import { markdownPlainText } from '@/lib/markdownPlainText';
import { cn } from '@renderer/utils/utils';

/**
 * Renders markdown as stripped plain text — no syntax characters, no line breaks.
 * Intended for compact single-line previews like issue descriptions.
 */
export function InlineMarkdown({ content, className }: { content: string; className?: string }) {
  return <div className={cn(className)}>{markdownPlainText(content)}</div>;
}
