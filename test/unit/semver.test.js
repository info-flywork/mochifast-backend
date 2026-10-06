import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/semver.js';

describe('compareVersions', () => {
  it('sayısal karşılaştırır (sözlük sırası değil)', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.12', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0+45', '2.0.0')).toBe(0);
    expect(compareVersions('abc', '1.0.0')).toBeNull();
  });
});
