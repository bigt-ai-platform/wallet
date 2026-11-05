import { describe, expect, it } from 'vitest';
import { formatDateTime, utcOffsetLabelFromMinutes } from '../timeformat';

describe('utcOffsetLabelFromMinutes', () => {
  it('formats whole-hour offsets', () => {
    expect(utcOffsetLabelFromMinutes(0)).toBe('UTC+0');
    expect(utcOffsetLabelFromMinutes(2 * 60)).toBe('UTC+2');
    expect(utcOffsetLabelFromMinutes(-5 * 60)).toBe('UTC-5');
  });

  it('formats minute offsets', () => {
    expect(utcOffsetLabelFromMinutes(5 * 60 + 30)).toBe('UTC+5:30');
    expect(utcOffsetLabelFromMinutes(-(3 * 60 + 30))).toBe('UTC-3:30');
  });
});

describe('formatDateTime', () => {
  it('renders an output timestamp as local YYYY-MM-DD HH:mm', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5); // local time
    expect(formatDateTime(Math.floor(d.getTime() / 1000))).toBe('2026-01-02 03:04');
  });
});
