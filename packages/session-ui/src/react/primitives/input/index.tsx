import { Input as InputPrimitive } from '@base-ui/react/input';
import { inputVariants, type InputVariantProps } from '@session-ui/styles/recipes/input';
import { cx } from '@session-ui/styles/utilities/cx';
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';

export type InputProps = FixedDataSlotProps<Omit<React.ComponentProps<'input'>, 'size'>> &
  InputVariantProps;

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, size = 'base', bare = false, ...props },
  ref
) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      ref={ref}
      className={cx(inputVariants({ size, bare }), className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.currentTarget.blur();
        }
      }}
      {...props}
    />
  );
});

export { Input };
