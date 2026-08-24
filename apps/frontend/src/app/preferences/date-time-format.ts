import { readonly, ref, type DeepReadonly, type Ref } from "vue";

export const dateTimeFormats = [
  "locale",
  "ymd-24",
  "ymd-12",
  "dmy-24",
  "mdy-12",
  "iso8601",
] as const;
export type DateTimeFormat = (typeof dateTimeFormats)[number];

const STORAGE_KEY = "apinteract.dateTimeFormat";
const dateTimeFormat = ref<DateTimeFormat>(readDateTimeFormat());

/** Provides the saved date/time format and the operation that replaces it. */
export interface DateTimeFormatPreference {
  readonly dateTimeFormat: DeepReadonly<Ref<DateTimeFormat>>;
  readonly setDateTimeFormat: (format: DateTimeFormat) => void;
}

/** Exposes the browser-wide timestamp preference to settings and consumers. */
export function useDateTimeFormatPreference(): DateTimeFormatPreference {
  return {
    dateTimeFormat: readonly(dateTimeFormat),
    setDateTimeFormat,
  };
}

/** Formats one instant using the selected locale-aware or fixed preset. */
export function formatDateTime(
  value: string | number | Date,
  locale: string | undefined,
  format: DateTimeFormat = dateTimeFormat.value,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (format === "locale") {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  const hour24 = date.getHours();
  const minute = twoDigits(date.getMinutes());
  const second = twoDigits(date.getSeconds());
  const time24 = `${twoDigits(hour24)}:${minute}:${second}`;
  if (format === "ymd-24") return `${year}-${month}-${day} ${time24}`;
  if (format === "dmy-24") return `${day}/${month}/${year} ${time24}`;
  if (format === "iso8601") {
    return `${year}-${month}-${day}T${time24}${localOffset(date)}`;
  }
  const period = hour24 < 12 ? "AM" : "PM";
  const time12 = `${twoDigits(hour24 % 12 || 12)}:${minute}:${second} ${period}`;
  return format === "ymd-12"
    ? `${year}-${month}-${day} ${time12}`
    : `${month}/${day}/${year} ${time12}`;
}

/** Persists the selected preset for every timestamp rendered in this browser. */
function setDateTimeFormat(format: DateTimeFormat): void {
  dateTimeFormat.value = format;
  try {
    window.localStorage.setItem(STORAGE_KEY, format);
  } catch {
    // Browser storage can be disabled; the active document still reflects it.
  }
}

/** Selects a validated stored format or falls back to locale conventions. */
function readDateTimeFormat(): DateTimeFormat {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDateTimeFormat(stored) ? stored : "locale";
  } catch {
    return "locale";
  }
}

/** Reports whether a persisted string names one supported format preset. */
export function isDateTimeFormat(
  value: string | null,
): value is DateTimeFormat {
  return (dateTimeFormats as readonly string[]).includes(value ?? "");
}

/** Pads one date/time field to the fixed two-digit preset width. */
function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Returns this instant's local ISO 8601 offset without changing its timezone. */
function localOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) return "Z";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `${sign}${twoDigits(Math.floor(absoluteMinutes / 60))}:${twoDigits(absoluteMinutes % 60)}`;
}
