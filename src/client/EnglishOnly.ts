/**
 * Landpot is English only: the page is not translated, and dates and numbers
 * are formatted in en-US whatever the visitor's system locale is.
 *
 * Upstream formats with the system locale in about sixty places
 * (`toLocaleString()`, `new Intl.NumberFormat(undefined, …)`, …). Rather than
 * edit each of them, this module makes `en-US` the default locale once: every
 * call that names no locale gets en-US, and a call that names one keeps it.
 * Import it before anything else (first line of Main.ts; tests/setup.ts).
 */

export const LANDPOT_LOCALE = "en-US";

type LocaleArg = string | string[] | Intl.Locale | Intl.Locale[] | undefined;

const pick = (locales: LocaleArg): LocaleArg => locales ?? LANDPOT_LOCALE;

const PATCHED = Symbol.for("landpot.englishOnly");

function patchIntl(): void {
  const names = [
    "NumberFormat",
    "DateTimeFormat",
    "Collator",
    "PluralRules",
    "RelativeTimeFormat",
    "ListFormat",
    "DisplayNames",
    "Segmenter",
  ] as const;
  const intl = Intl as unknown as Record<string, unknown>;
  for (const name of names) {
    const original = intl[name];
    if (typeof original !== "function") continue;
    // A Proxy keeps statics (supportedLocalesOf), the prototype and
    // `instanceof` intact; only the locale argument changes.
    intl[name] = new Proxy(original, {
      construct(target, args, newTarget) {
        const [locales, ...rest] = args as [LocaleArg, ...unknown[]];
        return Reflect.construct(target, [pick(locales), ...rest], newTarget);
      },
      apply(target, thisArg, args) {
        const [locales, ...rest] = args as [LocaleArg, ...unknown[]];
        return Reflect.apply(target, thisArg, [pick(locales), ...rest]);
      },
    });
  }
}

function patchMethod(proto: object, name: string, localeIndex: number): void {
  const p = proto as Record<string, unknown>;
  const original = p[name];
  if (typeof original !== "function") return;
  Object.defineProperty(proto, name, {
    configurable: true,
    writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      if (args[localeIndex] === undefined) {
        // Pad so the locale lands in its position even when omitted.
        while (args.length < localeIndex) args.push(undefined);
        args[localeIndex] = LANDPOT_LOCALE;
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    },
  });
}

export function installEnglishOnly(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[PATCHED]) return;
  g[PATCHED] = true;
  patchIntl();
  patchMethod(Number.prototype, "toLocaleString", 0);
  patchMethod(BigInt.prototype, "toLocaleString", 0);
  patchMethod(Date.prototype, "toLocaleString", 0);
  patchMethod(Date.prototype, "toLocaleDateString", 0);
  patchMethod(Date.prototype, "toLocaleTimeString", 0);
  patchMethod(Array.prototype, "toLocaleString", 0);
  patchMethod(String.prototype, "localeCompare", 1);
  if (typeof document !== "undefined") document.documentElement.lang = "en";
}

installEnglishOnly();
