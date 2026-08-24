// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { formatDateTime } from "../src/app/preferences/date-time-format";

describe("date/time formatting", () => {
  const instant = new Date(2026, 7, 24, 15, 21, 47);

  it("supports locale conventions alongside fixed common formats", () => {
    expect(formatDateTime(instant, "en-US", "locale")).toBe(
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(instant),
    );
    expect(formatDateTime(instant, "en-US", "ymd-24")).toBe(
      "2026-08-24 15:21:47",
    );
    expect(formatDateTime(instant, "en-US", "ymd-12")).toBe(
      "2026-08-24 03:21:47 PM",
    );
    expect(formatDateTime(instant, "en-US", "dmy-24")).toBe(
      "24/08/2026 15:21:47",
    );
    expect(formatDateTime(instant, "en-US", "mdy-12")).toBe(
      "08/24/2026 03:21:47 PM",
    );
    expect(formatDateTime(instant, "en-US", "iso8601")).toMatch(
      /^2026-08-24T15:21:47(?:Z|[+-]\d{2}:\d{2})$/u,
    );
  });
});
