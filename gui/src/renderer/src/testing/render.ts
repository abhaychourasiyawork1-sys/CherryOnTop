import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React only runs effects synchronously inside act() when it is told it is in
// a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts a React element into a detached container, jsdom-only. The whole
 *  harness: no testing-library, because a few lines of act() cover it. */
export function render(element: React.ReactElement): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    root,
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

/** Sets a textarea/input value the way React notices it. */
export function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  act(() => { element.dispatchEvent(new Event('input', { bubbles: true })); });
}

export function key(element: Element, keyName: string, init: KeyboardEventInit = {}): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init })); });
}

export async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
