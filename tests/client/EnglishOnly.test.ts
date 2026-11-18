import { describe, expect, it } from "vitest";
import { LANDPOT_LOCALE } from "../../src/client/EnglishOnly";

// tests/setup.ts installs the patch, as Main.ts does in the page.
describe("English-only locale", () => {
  const date = new Date(Date.UTC(2026, 10, 9, 12));

  it("formats numbers and dates in en-US when no locale is named", () => {
    expect((5000).toLocaleString()).toBe("5,000");
    expect(new Intl.NumberFormat().format(18450)).toBe("18,450");
    expect(
      date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }),
    ).toBe("Nov");
    expect(
      new Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).format(date),
    ).toBe("11/9/2026");
    expect(new Intl.NumberFormat().resolvedOptions().locale).toBe(
      LANDPOT_LOCALE,
    );
  });

  it("keeps a locale the caller names", () => {
    expect((5000).toLocaleString("de-DE")).toBe("5.000");
    expect(new Intl.NumberFormat("de-DE").format(5000)).toBe("5.000");
  });

  it("leaves Intl's statics and instanceof working", () => {
    expect(new Intl.NumberFormat()).toBeInstanceOf(Intl.NumberFormat);
    expect(Intl.NumberFormat.supportedLocalesOf(["en-US"])).toEqual(["en-US"]);
  });
});
