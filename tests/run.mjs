// Regression test runner (RULE 5).
// Transpiles the pure-logic libs with the repo's esbuild, then executes the
// node:test suite against them. Zero new dependencies.
//   node tests/run.mjs
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let baseDir = tmpdir();
try {
  const localTmp = join(process.cwd(), 'node_modules', '.tmp');
  if (!existsSync(localTmp)) mkdirSync(localTmp, { recursive: true });
  baseDir = localTmp;
} catch {
  baseDir = tmpdir();
}

const OUT = mkdtempSync(join(baseDir, 'kss-regression-'));
const entries = ['errors', 'safeStorage', 'attendanceEngine', 'hierarchy', 'leaveAnalyticsService', 'leaveHistorySummaryService', 'leaveLopSummaryService'];

for (const name of entries) {
  esbuild.buildSync({
    entryPoints: [`src/lib/${name}.ts`],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['exceljs'],
    outfile: join(OUT, `${name}.cjs`)
  });
}

const testFiles = [
  join('tests', 'regression.test.mjs'),
  join('tests', 'fcm.test.mjs'),
  join('tests', 'rtdb.test.mjs'),
  join('tests', 'hierarchy.test.mjs'),
  join('tests', 'leave.test.mjs'),
  join('tests', 'leaveAnalytics.test.mjs'),
  join('tests', 'leaveHistorySummary.test.mjs'),
  join('tests', 'leaveLopSummary.test.mjs')
];

const testRes = spawnSync(
  process.execPath,
  ['--test', ...testFiles],
  { stdio: 'inherit', env: { ...process.env, KSS_TEST_OUT: OUT } }
);
process.exit(testRes.status ?? 1);
