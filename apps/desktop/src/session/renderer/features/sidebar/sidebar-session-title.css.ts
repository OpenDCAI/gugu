import { createVar, keyframes, style } from '@vanilla-extract/css';

export const distance = createVar();
export const duration = createVar();

const revealTitle = keyframes({ to: { transform: `translateX(calc(-1 * ${distance}))` } });
const revealEnd = keyframes({
  '75%': { maskSize: '100% 100%' },
  to: { maskSize: 'calc(100% + 1em) 100%' },
});

const motion = {
  animationDuration: duration,
  animationDelay: '350ms',
  animationTimingFunction: 'cubic-bezier(0.49, 0.6, 0.7, 1)',
  animationFillMode: 'forwards',
} as const;

export const viewport = style({
  display: 'block', minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
  selectors: {
    '&[data-overflow]': {
      maskImage: 'linear-gradient(to right, black calc(100% - 1em), transparent)',
      maskRepeat: 'no-repeat',
    },
  },
  '@media': {
    '(prefers-reduced-motion: no-preference)': {
      selectors: {
        '[data-session-id]:is(:hover, :focus-visible) &[data-overflow], [data-session-id] button:focus-visible &[data-overflow]': {
          ...motion, animationName: revealEnd,
        },
      },
    },
  },
});

export const content = style({
  display: 'block', width: 'max-content', minWidth: '100%',
  '@media': {
    '(prefers-reduced-motion: no-preference)': {
      selectors: {
        [`[data-session-id]:is(:hover, :focus-visible) ${viewport}[data-overflow] &`]: {
          ...motion, animationName: revealTitle,
        },
        [`[data-session-id] button:focus-visible ${viewport}[data-overflow] &`]: {
          ...motion, animationName: revealTitle,
        },
      },
    },
  },
});
