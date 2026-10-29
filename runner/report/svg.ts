// The report's charts: inline SVG line charts, drawn from timeseries.json / db.json numbers. No scripts, no external
// files. Colours come from CSS custom properties the page defines (--series-0, --series-1, --surface, --ink-2, --grid),
// with light-mode fallbacks so a chart pasted on its own still reads. One y axis per chart: two measures of different
// kinds are two charts.

import { escapeHtml } from './html.js';

export interface ChartSeries {
  name: string;
  /** [x, y] pairs, x in seconds from the start of the run. */
  points: [number, number][];
}

export interface ChartOptions {
  width: number;
  height: number;
  /** The unit (or quantity and unit) of the y axis; shown above the plot. */
  yLabel: string;
  /** What the chart shows, for screen readers; defaults to the y label. */
  title?: string;
  xLabel?: string;
  /** Fix the x range (seconds, from 0) so stacked charts share one time axis. */
  xMax?: number;
  /** Fix the top of the y axis. */
  yMax?: number;
  /** Shaded stretches of time (for example the steady state). */
  bands?: { from: number; to: number; label: string }[];
  /** Horizontal reference lines (for example the 80% database flag). */
  hlines?: { y: number; label: string }[];
  /** Vertical markers (for example the breaking point). */
  vlines?: { x: number; label: string }[];
}

const FALLBACK = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6'];
const TIME_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const MAX_X_TICKS = 8;

const num = (n: number): string => String(Math.round(n * 10) / 10);

/** A 1-2-5 step that gives about `target` intervals over `range`. */
function niceStep(range: number, target: number): number {
  const raw = range / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
}

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/**
 * One line per series on a shared axis: a path per series (a dot when it has a single point), gridlines, ticks, a legend
 * for two or more series, optional bands, reference lines and markers.
 * @returns the `<svg>` element, sized by viewBox so it scales with its container
 */
export function lineChart(series: ChartSeries[], opts: ChartOptions): string {
  const { width, height } = opts;
  const all = series.flatMap((s) => s.points);
  const hasData = all.length > 0;
  const dataMaxX = hasData ? Math.max(...all.map((p) => p[0])) : 0;
  const xMax = Math.max(opts.xMax ?? dataMaxX, 1);
  const dataMaxY = hasData ? Math.max(...all.map((p) => p[1])) : 0;
  const refMax = Math.max(0, ...(opts.hlines ?? []).map((l) => l.y));
  const wanted = opts.yMax ?? Math.max(dataMaxY, refMax);
  const yStep = niceStep(Math.max(wanted, 1e-9) || 1, 4);
  const yMax = opts.yMax ?? Math.max(yStep, Math.ceil(wanted / yStep) * yStep);

  const legendRow = series.length >= 2 ? 16 : 0;
  const top = 8 + 14 + legendRow + 6;
  const left = 46;
  const right = 14;
  const bottom = opts.xLabel === undefined ? 24 : 40;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (v: number): number => left + (Math.min(v, xMax) / xMax) * plotW;
  const y = (v: number): number => top + plotH - (Math.min(v, yMax) / yMax) * plotH;

  const out: string[] = [];
  const label = `${opts.title ?? opts.yLabel}${series.length > 0 ? `: ${series.map((s) => s.name).join(', ')}` : ''}`;
  out.push(
    `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="xMidYMid meet">`,
    `<title>${escapeHtml(label)}</title>`,
  );

  for (const band of opts.bands ?? []) {
    const x0 = x(band.from);
    out.push(
      `<rect class="band" x="${num(x0)}" y="${top}" width="${num(Math.max(0, x(band.to) - x0))}" height="${num(plotH)}" fill="var(--series-0, ${FALLBACK[0]})" fill-opacity="0.08"/>`,
      `<text class="tick" x="${num(x0 + 4)}" y="${top + 11}" fill="var(--ink-2, #52514e)" font-size="10">${escapeHtml(band.label)}</text>`,
    );
  }

  for (let v = 0; v <= yMax + yStep / 1000; v += yStep) {
    out.push(
      `<line class="grid" x1="${left}" x2="${width - right}" y1="${num(y(v))}" y2="${num(y(v))}" stroke="var(--grid, #e1e0d9)" stroke-width="1"/>`,
      `<text class="tick" x="${left - 6}" y="${num(y(v) + 3.5)}" text-anchor="end" fill="var(--ink-3, #898781)" font-size="10">${num(v)}</text>`,
    );
  }
  const xStep = TIME_STEPS.find((s) => xMax / s <= MAX_X_TICKS) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  for (let v = 0; v <= xMax + 1e-9; v += xStep) {
    out.push(`<text class="tick" x="${num(x(v))}" y="${top + plotH + 14}" text-anchor="middle" fill="var(--ink-3, #898781)" font-size="10">${clock(v)}</text>`);
  }
  out.push(`<line class="axis" x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="var(--axis, #c3c2b7)" stroke-width="1"/>`);
  if (opts.xLabel !== undefined) {
    out.push(`<text class="axis-label" x="${num(left + plotW / 2)}" y="${height - 6}" text-anchor="middle" fill="var(--ink-2, #52514e)" font-size="11">${escapeHtml(opts.xLabel)}</text>`);
  }
  out.push(`<text class="axis-label" x="${left}" y="16" fill="var(--ink-2, #52514e)" font-size="11">${escapeHtml(opts.yLabel)}</text>`);

  for (const line of opts.hlines ?? []) {
    out.push(
      `<line class="ref" x1="${left}" x2="${width - right}" y1="${num(y(line.y))}" y2="${num(y(line.y))}" stroke="var(--ink-2, #52514e)" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<text class="tick" x="${left + 4}" y="${num(y(line.y) - 3)}" fill="var(--ink-2, #52514e)" font-size="10">${escapeHtml(line.label)}</text>`,
    );
  }
  for (const line of opts.vlines ?? []) {
    out.push(
      `<line class="ref" x1="${num(x(line.x))}" x2="${num(x(line.x))}" y1="${top}" y2="${top + plotH}" stroke="var(--ink-2, #52514e)" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<text class="tick" x="${num(x(line.x) + 4)}" y="${top + 22}" fill="var(--ink-2, #52514e)" font-size="10">${escapeHtml(line.label)}</text>`,
    );
  }

  series.forEach((s, i) => {
    const colour = `var(--series-${i}, ${FALLBACK[i % FALLBACK.length]})`;
    const points = [...s.points].sort((a, b) => a[0] - b[0]);
    if (points.length >= 2) {
      const d = points.map(([px, py], k) => `${k === 0 ? 'M' : 'L'}${num(x(px))},${num(y(py))}`).join(' ');
      out.push(`<path class="line" d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    const last = points[points.length - 1];
    if (last) {
      out.push(`<circle class="end" cx="${num(x(last[0]))}" cy="${num(y(last[1]))}" r="4" fill="${colour}" stroke="var(--surface, #fcfcfb)" stroke-width="2"/>`);
    }
  });

  if (legendRow > 0) {
    let lx = left;
    for (const [i, s] of series.entries()) {
      const colour = `var(--series-${i}, ${FALLBACK[i % FALLBACK.length]})`;
      out.push(
        `<line class="key" x1="${lx}" x2="${lx + 16}" y1="${top - 10}" y2="${top - 10}" stroke="${colour}" stroke-width="2" stroke-linecap="round"/>`,
        `<text class="legend" x="${lx + 21}" y="${top - 6.5}" fill="var(--ink-2, #52514e)" font-size="11">${escapeHtml(s.name)}</text>`,
      );
      lx += 21 + s.name.length * 6.2 + 16;
    }
  }

  if (!hasData) {
    out.push(`<text class="empty" x="${num(left + plotW / 2)}" y="${num(top + plotH / 2)}" text-anchor="middle" fill="var(--ink-3, #898781)" font-size="12">No data recorded</text>`);
  }
  out.push('</svg>');
  return out.join('');
}
