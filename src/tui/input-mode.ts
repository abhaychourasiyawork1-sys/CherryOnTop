import { createContext, useContext } from 'react';

/** Screens that own the keyboard (a text field, a filter prompt) flip this so
 *  the app-level global keybindings stop swallowing letters as commands. */
export const TextEntryContext = createContext<(active: boolean) => void>(() => {});

export function useTextEntry() {
  return useContext(TextEntryContext);
}
