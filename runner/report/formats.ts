// How the report writes a number. Each format rounds once, from the source value, so the page and the check that
// re-evaluates the source produce the same text.

const thousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** `value` to `places` decimals, trailing zeros dropped, no negative zero. */
const trimmed = (value: number, places: number): string => thousands(String(Number(value.toFixed(places))));

/** How a number reads on the page; each rounds once, from the source value. */
export const FORMATS = {
  /** 1,446 */
  int: (n: number) => thousands(String(Math.round(n) + 0)),
  dec1: (n: number) => trimmed(n, 1),
  dec2: (n: number) => trimmed(n, 2),
  /** a fraction as a percent: 0.0123 -> 1.23% */
  pct: (n: number) => `${trimmed(n * 100, 2)}%`,
  /** a value that is already a percent: 46.09 -> 46.1% */
  pctPoints: (n: number) => `${trimmed(n, 1)}%`,
  /** +250 / -80 / 0 */
  signedInt: (n: number) => {
    const text = thousands(String(Math.round(n) + 0));
    return n > 0 && Math.round(n) > 0 ? `+${text}` : text;
  },
  /** a fraction as a whole percent with its sign: +26% */
  signedPct: (n: number) => {
    const whole = Math.round(n * 100) + 0;
    return `${whole > 0 ? '+' : ''}${thousands(String(whole))}%`;
  },
  /** seconds as 20 s / 13 min 1 s / 1 h 2 min */
  dur: (n: number) => {
    const total = Math.round(n);
    if (total < 60) return `${total} s`;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h} h${m > 0 ? ` ${m} min` : ''}`;
    return `${m} min${s > 0 ? ` ${s} s` : ''}`;
  },
  /** 2.8× */
  ratio: (n: number) => `${trimmed(n, 1)}×`,
} satisfies Record<string, (n: number) => string>;

export type FormatName = keyof typeof FORMATS;

export const isFormat = (name: string): name is FormatName => Object.hasOwn(FORMATS, name);

export function formatNumber(format: FormatName, value: number): string {
  return FORMATS[format](value);
}

