import type { JSX } from 'react';

/**
 * Shared branch/stem geometry used by organization, recovery evidence, and architecture.
 * With `formsMark`, the two branches settle into the cherry mark silhouette.
 */
export function BranchStem(props: { variant: 'organization' | 'evidence' | 'architecture'; formsMark?: boolean }): JSX.Element {
  const { variant, formsMark = false } = props;
  return (
    <svg
      className={`branch-stem branch-stem--${variant}${formsMark ? ' branch-stem--mark' : ''}`}
      data-motif="branch-stem"
      data-forms-mark={formsMark ? 'true' : undefined}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <path className="branch-stem__trunk" d="M32 60 V34" />
      <path className="branch-stem__branch" d={formsMark ? 'M32 34 C30 22 22 16 18 12' : 'M32 34 C26 30 20 28 14 28'} />
      <path className="branch-stem__branch" d={formsMark ? 'M32 34 C36 24 42 20 46 18' : 'M32 34 C38 30 44 28 50 28'} />
      {formsMark ? (
        <>
          <circle className="branch-stem__fruit" cx="18" cy="44" r="9" />
          <circle className="branch-stem__fruit" cx="46" cy="46" r="9" />
        </>
      ) : null}
    </svg>
  );
}
