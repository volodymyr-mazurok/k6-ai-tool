// The report as sections of blocks, in the order the design fixes: Verdict, What ran, Under what load, Results per step,
// Breaking point (stress only), Database, Compared with baseline, Automatic flags, Findings and recommendations (only when
// the run folder has findings.md), Files.

import type { ReportModel } from './build.js';
import { breakingSection } from './viewBreaking.js';
import { Ctx, ident, text, utcMinute, type Block, type ReportView, type Section } from './viewCore.js';
import { databaseSection } from './viewDb.js';
import { loadSection } from './viewLoad.js';
import { verdictSection, whatRanSection } from './viewRun.js';
import { baselineSection, flagsSection, stepsSection } from './viewSteps.js';

export { maskSql } from './viewDb.js';

const FILE_MEANING: Record<string, string> = {
  'report.html': 'This page.',
  'report.md': 'The same report as Markdown.',
  'findings.md': 'Ranked findings and recommendations, written from this run’s files.',
  'summary.json': 'k6’s end-of-test numbers: response times, failures and checks per step.',
  'timeseries.json': 'Users, requests and p95 over time, in fixed-length slices.',
  'points.json.gz': 'Every raw k6 data point, compressed.',
  'k6-dashboard.html': 'k6’s own interactive dashboard of the run.',
  'k6-config.json': 'The settings the runner gave k6. Holds no secrets.',
  'k6.log': 'What k6 printed while it ran.',
  'db.json': 'Database evidence: resource samples, top statements, missing indexes.',
  'meta.json': 'Facts about the run: profile, git commit, k6 version, guardrails, row counts.',
};

function filesSection(ctx: Ctx): Section {
  const { files } = ctx.model;
  const blocks: Block[] = [
    {
      kind: 'table',
      head: [{ label: 'File' }, { label: 'What it is' }],
      rows: files.map((name) => [{ parts: [name], cls: 'id' as const, href: name }, text(FILE_MEANING[name] ?? '')]),
    },
  ];
  return { id: 'files', title: 'Files', blocks };
}

export function buildView(model: ReportModel): ReportView {
  const ctx = new Ctx(model);
  const { meta } = model;
  const sections: Section[] = [verdictSection(ctx), whatRanSection(ctx), loadSection(ctx), stepsSection(ctx)];
  if (meta.profile.type === 'stress') sections.push(breakingSection(ctx));
  sections.push(databaseSection(ctx), baselineSection(ctx), flagsSection(ctx));
  if (model.findings !== undefined) {
    sections.push({ id: 'findings', title: 'Findings and recommendations', blocks: [{ kind: 'markdown', text: model.findings }] });
  }
  sections.push(filesSection(ctx));
  return {
    title: `Performance report: ${meta.project} ${meta.feature} ${meta.profile.type} on ${meta.env}`,
    subtitle: ident(`${meta.runId} · ${utcMinute(meta.startedAt)}`),
    verdict: model.verdict.verdict,
    sections,
  };
}
