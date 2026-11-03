const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone, which is what config validation wants.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedTime {
  /** 0 = Sunday … 6 = Saturday, as in `Date.getDay()`. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
  second: number;
  /** `HH:MM` in the zone. */
  clock: string;
}

export function zonedTime(date: Date, timeZone: string): ZonedTime {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
    minutes: hour * 60 + minute,
    second: Number(parts.second),
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/**
 * Epoch milliseconds of the most recent local midnight in `timeZone`. On a daylight-saving
 * change day this can be off by the size of the shift, which only moves the reset by that hour.
 */
export function startOfZonedDay(date: Date, timeZone: string): number {
  const local = zonedTime(date, timeZone);
  return date.getTime() - (local.minutes * 60 + local.second) * 1_000 - date.getUTCMilliseconds();
}

/** Parses `HH:MM` (24-hour, `24:00` allowed as an end) into minutes since midnight. */
export function parseClock(text: string, label: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || minutes > 59 || hours > 24 || (hours === 24 && minutes > 0)) {
    throw new Error(`${label} must be a 24-hour time like "09:30", got "${text}"`);
  }
  return hours * 60 + minutes;
}

export function assertTimeZone(timeZone: string, label: string): void {
  try {
    formatterFor(timeZone);
  } catch {
    throw new Error(`${label}: unknown time zone "${timeZone}"`);
  }
}

export function weekdayName(day: number): string {
  return WEEKDAYS[day] ?? String(day);
}
