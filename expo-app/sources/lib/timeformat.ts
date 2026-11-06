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

/** Local `YYYY-MM-DD HH:mm` for a chain output timestamp (epoch seconds). */
export function formatDateTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Timezone label in effect for an instant, e.g. "UTC", "UTC+2", "UTC+5:30".
 * Unlike {@link utcOffsetLabel} (which labels *now*), this uses the offset at
 * `epochSeconds`, so a date rendered across a DST boundary is labelled with the
 * offset that was actually in force.
 */
export function timeZoneLabel(epochSeconds: number): string {
  const minutes = -new Date(epochSeconds * 1000).getTimezoneOffset();
  return minutes === 0 ? 'UTC' : utcOffsetLabelFromMinutes(minutes);
}

/**
 * `YYYY-MM-DD HH:mm (UTC)` — the instant in the device/user timezone, with the
 * zone spelled out so the reader never has to guess which clock it is.
 */
export function formatDateTimeZone(epochSeconds: number): string {
  return `${formatDateTime(epochSeconds)} (${timeZoneLabel(epochSeconds)})`;
}

/** Timezone label of the device at the given instant (ms), e.g. "UTC", "UTC+2". */
export function utcOffsetLabel(ms: number): string {
  return timeZoneLabel(Math.floor(ms / 1000));
}
