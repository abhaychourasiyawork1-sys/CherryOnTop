import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

describe('site package smoke', () => {
  it('initializes under jsdom', () => {
    expect(typeof document).toBe('object');
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    expect(document.getElementById('root')).not.toBeNull();
  });
});
