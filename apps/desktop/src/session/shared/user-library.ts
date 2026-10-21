/** Gugu-owned resource notes. Projects, connected devices and assistant memory keep their existing identities. */
export type UserLibraryKind = 'capabilities' | 'devices';
export type UserLibraryVolume = { kind: UserLibraryKind; name: string; path: string; index: string };
export type UserLibrary = { root: string; volumes: UserLibraryVolume[] };
export type UserLibraryItem = {
  id: string; name: string; description: string; group: string | null;
  path: string; index: string; modifiedAt: string;
};
export type UserLibraryEntry = UserLibraryItem & { content: string };
export type UserLibraryWrite = {
  kind: UserLibraryKind; id?: string; name: string; description: string;
  group: string | null; content: string; expectedModifiedAt?: string;
};
export type UserLibraryRead = { volume: UserLibraryVolume; content: string; items: UserLibraryItem[] };
