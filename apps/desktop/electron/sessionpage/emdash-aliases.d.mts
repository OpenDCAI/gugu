// @@@sessionpage — declaration for emdash-aliases.mjs so gugu's root tsc (which typechecks
// vite.config.mts) can type the dynamic import even though the sessionpage dir is excluded from the
// root program.
export declare const emdashAliasEntries: Array<[string, string]>
export declare const emdashWorkerEntries: Array<{ out: string; src: string }>
