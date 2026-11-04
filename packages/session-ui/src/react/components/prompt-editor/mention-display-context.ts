import { createContext } from 'react';
import type { ContextMentionProvider } from './types';

/** Resolve live presentation without changing the editor's serialized target or label. */
export const MentionDisplayContext = createContext<ContextMentionProvider['resolve'] | undefined>(undefined);
