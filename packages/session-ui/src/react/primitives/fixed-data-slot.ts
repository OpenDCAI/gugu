// JSX permits unknown hyphenated props, so `never` is required in addition to `Omit`.
export type FixedDataSlotProps<Props> = Omit<Props, 'data-slot'> & {
  'data-slot'?: never;
};
