import { inputVariants, type InputVariantProps } from '@session-ui/styles/recipes/input';
import { cx } from '@session-ui/styles/utilities/cx';
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';
import { textareaOverride } from './textarea.css';

export type TextareaProps = FixedDataSlotProps<React.ComponentProps<'textarea'>> & {
  /** Match the visual size token from inputVariants (height constraint is dropped for auto-grow). */
  size?: InputVariantProps['size'];
};

function Textarea({ className, size = 'base', ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cx(inputVariants({ size }), textareaOverride, className)}
      {...props}
    />
  );
}

export { Textarea };
