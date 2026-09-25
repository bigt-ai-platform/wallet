import { describe, it, expect, beforeEach } from 'vitest';
import { BaseTaggableObject } from '../../src/index';

describe('BaseTaggableObject', () => {
  let obj: BaseTaggableObject;

  beforeEach(() => {
    obj = new BaseTaggableObject();
  });

  it('tags', () => {
    expect(obj.maybeGetTag('foo')).toBeNull();
    obj.setTag('foo', new TextEncoder().encode('bar'));
    expect(obj.getTag('foo')).not.toBeNull();
  });

  it('exception', () => {
    expect(() => {
      obj.getTag('non existent');
    }).toThrow();
  });
});
