/**
 * "UTC+2" / "UTC-5" / "UTC+5:30" for a timezone offset in minutes east of UTC.
 */
export function utcOffsetLabelFromMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Timezone label of the device at the given instant, e.g. "UTC+2". */
export function utcOffsetLabel(ms: number): string {
  return utcOffsetLabelFromMinutes(-new Date(ms).getTimezoneOffset());
}
