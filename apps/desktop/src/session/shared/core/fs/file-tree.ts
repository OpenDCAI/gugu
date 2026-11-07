import type { FileTreeProjectionScope } from './fsEvents';

/** Result of opening a per-view projection subscription: the seed root scope + baseline version. */
export type FileTreeProjectionOpenData = {
  subscriptionId: string;
  version: number;
  scopes: FileTreeProjectionScope[];
};

/** Mutating a subscription (register/unregister/reveal) returns the version to wait for. */
export type FileTreeProjectionVersionData = {
  version: number;
};
