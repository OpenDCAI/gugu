import { createContext, useContext, type Accessor } from 'solid-js';

/** A retained view keeps its model and DOM; only height measurement pauses off screen. */
export const ViewShownContext = createContext<Accessor<boolean>>(() => true);
export const useViewShown = () => useContext(ViewShownContext);
