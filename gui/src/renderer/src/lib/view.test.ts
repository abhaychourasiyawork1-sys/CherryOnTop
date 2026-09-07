import { describe, it, expect } from 'vitest';
import { sectionOf, isCase } from './view.js';

describe('view', () => {
  it('lights Cases in the nav while you are inside one', () => {
    expect(sectionOf({ name: 'case', id: 'x', tab: 'proof', nodeId: null })).toBe('cases');
  });

  it('lights its own destination otherwise', () => {
    expect(sectionOf({ name: 'desk' })).toBe('desk');
    expect(sectionOf({ name: 'mandates' })).toBe('mandates');
  });

  it('narrows a case view', () => {
    expect(isCase({ name: 'desk' })).toBe(false);
    expect(isCase({ name: 'case', id: 'x', tab: 'conversation', nodeId: null })).toBe(true);
  });
});
