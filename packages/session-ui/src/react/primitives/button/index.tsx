import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { controlVariants, type ControlVariantProps } from '@session-ui/styles/recipes/control';
import { cx } from '@session-ui/styles/utilities/cx';
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';

export type ButtonProps = FixedDataSlotProps<ButtonPrimitive.Props> &
  ControlVariantProps & {
    /** Square aspect ratio; collapses padding. Combines with size. */
    icon?: boolean;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'ghost', tone = 'neutral', size = 'base', icon = false, ...props },
  ref
) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      className={cx(controlVariants({ variant, tone, size, icon }), className)}
      {...props}
    />
  );
});

export { Button };
