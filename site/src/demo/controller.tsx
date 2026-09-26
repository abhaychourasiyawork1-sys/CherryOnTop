import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type JSX,
} from 'react';
import { createInitialSnapshot, transition } from './state-machine';
import type { DemoEvent, DemoSnapshot, DemoState } from './types';

/**
 * Single source of truth for playback timing, in milliseconds. The demo
 * visuals read this instead of hardcoding their own timers.
 */
export const DEMO_TIMING: Record<Exclude<DemoState, 'memory'>, number> = {
  goal: 1200,
  organization: 1800,
  mandate: 2200,
  executing: 2600,
  failure: 1800,
  recovering: 2200,
  validating: 1800,
  verified: 2400,
  receipt: 2600,
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface DemoControllerValue {
  snapshot: DemoSnapshot;
  dispatch: (event: DemoEvent) => void;
  reducedMotion: boolean;
  replay: () => void;
}

const DemoControllerContext = createContext<DemoControllerValue | null>(null);

export function DemoControllerProvider(props: { children: React.ReactNode }): JSX.Element {
  const { children } = props;
  const [snapshot, dispatch] = useReducer(transition, undefined, createInitialSnapshot);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (snapshot.state === 'memory') {
      return undefined;
    }

    const delay = reducedMotion ? 0 : DEMO_TIMING[snapshot.state];
    timeoutRef.current = setTimeout(() => {
      dispatch({ type: 'NEXT' });
    }, delay);

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [snapshot.state, reducedMotion]);

  const replay = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    dispatch({ type: 'REPLAY' });
  }, []);

  const value = useMemo<DemoControllerValue>(
    () => ({ snapshot, dispatch, reducedMotion, replay }),
    [snapshot, reducedMotion, replay],
  );

  return <DemoControllerContext.Provider value={value}>{children}</DemoControllerContext.Provider>;
}

export function useDemoController(): DemoControllerValue {
  const context = useContext(DemoControllerContext);
  if (!context) {
    throw new Error('useDemoController must be used within a DemoControllerProvider');
  }
  return context;
}
