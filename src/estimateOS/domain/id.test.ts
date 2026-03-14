import { makeId } from './id';

describe('makeId', () => {
  it('returns a non-empty string', () => {
    expect(typeof makeId()).toBe('string');
    expect(makeId().length).toBeGreaterThan(0);
  });

  it('returns unique values on repeated calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, makeId));
    expect(ids.size).toBe(1000);
  });

  it('matches UUID v4 format', () => {
    const uuidV4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const id = makeId();
    expect(id).toMatch(uuidV4Re);
  });
});
