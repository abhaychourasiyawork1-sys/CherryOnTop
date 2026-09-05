import { createContext, useContext } from 'react';

/** Screens that own the keyboard (a text field, a filter prompt) flip this so
 *  the app-level global keybindings stop swallowing letters as commands.
 *  Escape is deliberately *not* covered by it — a screen the user cannot leave
 *  is worse than one that reacts to a stray letter. */
export const TextEntryContext = createContext<(active: boolean) => void>(() => {});

export function useTextEntry() {
  return useContext(TextEntryContext);
}

/** Set by a screen that consumes Escape itself (closing its own filter prompt,
 *  say) so the shell does not also pop the screen out from under it. */
export const EscapeOwnerContext = createContext<(owned: boolean) => void>(() => {});

export function useEscapeOwner() {
  return useContext(EscapeOwnerContext);
}
