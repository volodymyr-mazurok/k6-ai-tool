// Section 6 of the report: the database. Load figures, the statements that cost the most during the run, missing-index
// suggestions and the caveat. Statement text is shown with its literals masked: values a user typed never reach a report.

import { DB_CAVEAT } from '../dbPhase.js';
import { ALL, source, window } from './sources.js';
import { cell, Ctx, DASH, ident, text, type Block, type Cell, type Section } from './viewCore.js';

const TOP_STATEMENTS = 5;
const TOP_INDEXES = 10;
const STATEMENT_CHARS = 300;

/**
 * A SQL statement for people: string literals become '…' (an unterminated one is masked to the end), numeric and binary
 * literals become ?, block comments a placeholder, whitespace collapses, a SELECT's column list of 80 characters or more
 * becomes …, and the text is cut to about 300 characters. Digits inside names (f14, @p0, t1.x) stay.
 */
export function maskSql(sql: string, limit: number = STATEMENT_CHARS): string {
  const masked = sql
    .replace(/(?:(?<!\w)N)?'(?:[^']|'')*(?:'|$)/g, "'…'")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '/*…*/')
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/(?<![\w@#$.[\]])\d+(?:\.\d+)?(?:e[+-]?\d+)?(?!\w)/gi, '?')
    .replace(/\s+/g, ' ')
    .trim()
    // An EF Core SELECT lists every column before the part that tells statements apart: keep that part in view.
    .replace(/^(SELECT\s+(?:(?:TOP \(\?\)|DISTINCT)\s+)*)(.{80,}?)(\s+FROM\s)/i, '$1…$3');
  return masked.length > limit ? `${masked.slice(0, limit).trimEnd()}…` : masked;
}

const sql = (statement: string): Cell => ({ parts: [maskSql(statement)], cls: 'sql' });
const names = (columns: string[]): Cell => (columns.length > 0 ? ident(columns.join(', ')) : text(DASH));

export function databaseSection(ctx: Ctx): Section {
  const { db, dbHoldAvg, meta } = ctx.model;
  const blocks: Block[] = [];
  if (!db && meta.database === 'none') {
    blocks.push({ kind: 'text', parts: ['No database evidence (this project has no database access).'] });
    return { id: 'database', title: 'Database', blocks };
  }
  if (!db) {
    blocks.push({ kind: 'text', parts: ['No database evidence for this run: the project reads no database, or it could not be reached.'] });
    blocks.push({ kind: 'text', cls: 'note', parts: [`${DB_CAVEAT} Off-hours runs keep this small.`] });
    return { id: 'database', title: 'Database', blocks };
  }

  const facts: { label: string; value: Cell }[] = [{ label: 'Tier', value: ident([db.tier, db.edition].filter(Boolean).join(' ') || 'not reported') }];
  if (db.resource.length > 0) {
    facts.push({ label: 'Peak CPU', value: cell([ctx.num(`max(${source('db.json', 'resource', ALL, 'cpu')})`, 'pctPoints')]) });
    facts.push({ label: 'Peak data IO', value: cell([ctx.num(`max(${source('db.json', 'resource', ALL, 'dataIo')})`, 'pctPoints')]) });
  }
  const hold = meta.profile.holdWindow;
  if (dbHoldAvg && hold) {
    const samples = (field: string): string => source('db.json', 'resource', window('t', hold.fromSec, hold.toSec, true), field);
    facts.push({ label: 'CPU, average over the steady state', value: cell([ctx.num(`avg(${samples('cpu')})`, 'pctPoints')]) });
    facts.push({ label: 'Data IO, average over the steady state', value: cell([ctx.num(`avg(${samples('dataIo')})`, 'pctPoints')]) });
  }
  if (db.evicted > 0) {
    facts.push({ label: 'Statements evicted from the plan cache', value: cell([ctx.num(source('db.json', 'evicted'), 'int')], 'warn') });
  }
  blocks.push({ kind: 'facts', rows: facts });
  blocks.push({ kind: 'text', cls: 'note', parts: ['The database load chart is under “Under what load”, on the same time axis as the request charts.'] });

  blocks.push({ kind: 'sub', title: 'Top statements during the run' });
  const top = db.topStatements
    .map((s, index) => ({ s, index }))
    .sort((a, b) => b.s.elapsedUs - a.s.elapsedUs)
    .slice(0, TOP_STATEMENTS);
  if (top.length === 0) {
    blocks.push({ kind: 'text', parts: ['No statement grew during the run (or its plan was evicted from the cache before it could be counted).'] });
  } else {
    const at = (index: number, field: string): string => source('db.json', 'topStatements', index, field);
    blocks.push({
      kind: 'table',
      head: ['Statement (values hidden)', 'Executions', 'Average (ms)', 'Total time (ms)', 'CPU time (ms)', 'Logical reads'].map((label, i) => ({ label, right: i > 0 })),
      rows: top.map(({ s, index }) => [
        sql(s.text),
        cell([ctx.num(at(index, 'executions'), 'int')]),
        cell([ctx.num(at(index, 'avgElapsedMs'), 'dec2')]),
        cell([ctx.num(`${at(index, 'elapsedUs')} / 1000`, 'int')]),
        cell([ctx.num(`${at(index, 'cpuUs')} / 1000`, 'int')]),
        cell([ctx.num(at(index, 'logicalReads'), 'int')]),
      ]),
      note: ['Sorted by total time. Total time adds up every execution during the run; a cheap statement run very often can outweigh a slow one run rarely.'],
    });
  }

  if (db.queryStore && db.queryStore.length > 0) {
    blocks.push({ kind: 'sub', title: 'From Query Store (the plan cache could not answer)' });
    const at = (index: number, field: string): string => source('db.json', 'queryStore', index, field);
    blocks.push({
      kind: 'table',
      head: ['Statement (values hidden)', 'Executions', 'Total time (ms)', 'CPU time (ms)', 'Logical reads', 'Interval'].map((label, i) => ({ label, right: i > 0 && i < 5 })),
      rows: db.queryStore
        .map((s, index) => ({ s, index }))
        .sort((a, b) => b.s.elapsedUs - a.s.elapsedUs)
        .slice(0, TOP_STATEMENTS)
        .map(({ s, index }) => [
          sql(s.text),
          cell([ctx.num(at(index, 'executions'), 'int')]),
          cell([ctx.num(`${at(index, 'elapsedUs')} / 1000`, 'int')]),
          cell([ctx.num(`${at(index, 'cpuUs')} / 1000`, 'int')]),
          cell([ctx.num(at(index, 'logicalReads'), 'int')]),
          ident(`${s.intervalStart.slice(0, 16).replace('T', ' ')} to ${s.intervalEnd.slice(11, 16)}`),
        ]),
      note: ['Query Store keeps whole intervals, so these numbers cover more than the run itself.'],
    });
  }

  blocks.push({ kind: 'sub', title: 'Missing indexes on the tables those statements touch' });
  const suggestions = db.missingIndexes
    .map((m, index) => ({ m, index }))
    .sort((a, b) => b.m.avgUserImpact - a.m.avgUserImpact)
    .slice(0, TOP_INDEXES);
  if (suggestions.length === 0) {
    blocks.push({ kind: 'text', parts: ['SQL Server suggests no missing index for those tables.'] });
  } else {
    const at = (index: number, field: string): string => source('db.json', 'missingIndexes', index, field);
    blocks.push({
      kind: 'table',
      head: ['Table', 'Equality columns', 'Inequality columns', 'Included columns', 'Expected gain', 'Seeks'].map((label, i) => ({ label, right: i >= 4 })),
      rows: suggestions.map(({ m, index }) => [
        ident(m.table),
        names(m.equality),
        names(m.inequality),
        names(m.included),
        cell([ctx.num(at(index, 'avgUserImpact'), 'pctPoints')]),
        cell([ctx.num(at(index, 'userSeeks'), 'int')]),
      ]),
      note: ['These are SQL Server’s own suggestions, collected since it last restarted. They are leads for the database owner, not a verdict: an index also slows writes.'],
    });
  }

  if (db.errors && db.errors.length > 0) {
    blocks.push({ kind: 'text', cls: 'warn', parts: [`Some database evidence could not be collected: ${db.errors.join('; ')}.`] });
  }
  blocks.push({ kind: 'text', cls: 'note', parts: [`${db.caveat || DB_CAVEAT} Off-hours runs keep this small.`] });
  return { id: 'database', title: 'Database', blocks };
}
