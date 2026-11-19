const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadDataset,
  loadFixtures,
  validateDataset,
  validateFixtures,
} = require('../modules/intake/eval/dataset');
const {
  runEvaluation,
  renderReport,
  parseArgs,
} = require('../modules/intake/eval/runEval');

const dataset = loadDataset();
const fixtures = loadFixtures();

test('dataset and fixtures validate against the form schemas', () => {
  const datasetCheck = validateDataset(dataset);
  assert.deepEqual(datasetCheck.errors, []);

  const fixtureCheck = validateFixtures(dataset, fixtures);
  assert.deepEqual(fixtureCheck.errors, []);
});

test('dataset covers every required evaluation category', () => {
  const tags = new Set(dataset.cases.flatMap((testCase) => testCase.tags || []));

  for (const required of [
    'routing',
    'ambiguous',
    'out_of_scope',
    'extraction',
    'enum_alias',
    'enum_rejection',
    'null_handling',
    'hallucination',
    'provenance_rejection',
    'malformed',
    'prompt_injection',
    'date_normalization',
    'date_rejection',
    'number_normalization',
    'auto_route',
  ]) {
    assert.equal(tags.has(required), true, `Missing coverage tag: ${required}`);
  }

  assert.ok(dataset.cases.length >= 35);
  assert.ok(dataset.limitations.length >= 8);
});

test('dataset has unique ids and only known form ids', () => {
  const ids = dataset.cases.map((testCase) => testCase.id);
  assert.equal(new Set(ids).size, ids.length);

  const known = new Set([
    'FORM_PATENT_INTAKE',
    'FORM_TAX_FILING',
    'FORM_EMPLOYEE_ONBOARDING',
    'FORM_INSURANCE_CLAIM',
    'FORM_SUPPORT_TICKET',
  ]);

  for (const testCase of dataset.cases) {
    if (testCase.form_id) assert.equal(known.has(testCase.form_id), true);
    if (testCase.expected?.form_id) {
      assert.equal(known.has(testCase.expected.form_id), true);
    }
  }
});

test('fixture-mode evaluation is deterministic and passes the baseline', async () => {
  const first = await runEvaluation({
    dataset,
    fixtures,
    mode: 'fixtures',
  });
  const second = await runEvaluation({
    dataset,
    fixtures,
    mode: 'fixtures',
  });

  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.summary.case_pass_rate, 1);
  assert.equal(first.summary.routing.accuracy, 1);
  assert.equal(first.summary.extraction.exact_match, 1);
  assert.equal(first.summary.extraction.precision, 1);
  assert.equal(first.summary.extraction.recall, 1);
  assert.equal(first.summary.extraction.null_accuracy, 1);
  assert.equal(first.summary.extraction.hallucination_rate, 0);
  assert.equal(first.summary.extraction.provenance_validity_rate, 1);
  assert.equal(first.summary.extraction.review_flag_accuracy, 1);
  assert.equal(first.summary.extraction.alias_normalization_accuracy, 1);
  assert.equal(first.summary.extraction.schema_violations, 0);
  assert.equal(first.summary.extraction.contract_violations, 0);
  assert.deepEqual(first.summary.failures, []);
  assert.equal(first.summary.totals.cases, dataset.cases.length);
});

test('tag filtering runs a deterministic subset', async () => {
  const evaluation = await runEvaluation({
    dataset,
    fixtures,
    mode: 'fixtures',
    filterTag: 'enum_alias',
  });

  assert.ok(evaluation.summary.totals.cases > 0);
  assert.ok(
    evaluation.results.every((result) => result.tags.includes('enum_alias'))
  );
  assert.equal(evaluation.summary.case_pass_rate, 1);
});

test('report labels fixture mode honestly and includes required sections', async () => {
  const evaluation = await runEvaluation({
    dataset,
    fixtures,
    mode: 'fixtures',
  });
  evaluation.dataset.path = 'dataset.json';
  const report = renderReport(evaluation, {
    limitations: dataset.limitations,
  });

  assert.ok(report.includes('# AI Intake Pipeline — Evaluation Report'));
  assert.ok(report.includes('Offline fixture replay (deterministic)'));
  assert.ok(report.includes('not** live model-quality measurements'));
  assert.ok(report.includes('## Summary'));
  assert.ok(report.includes('## Failure examples'));
  assert.ok(report.includes('## Known limitations'));
  assert.ok(report.includes('## Reproduce'));
  assert.ok(report.includes('100.0%'));
  assert.ok(report.includes('npm run eval'));
  assert.ok(report.includes('--live'));
  assert.equal(report.includes('undefined'), false);
});

test('invalid datasets and missing fixtures fail loudly', async () => {
  await assert.rejects(
    () =>
      runEvaluation({
        dataset: { cases: [] },
        fixtures,
        mode: 'fixtures',
      }),
    /Invalid dataset/
  );

  const incompleteFixtures = {
    routing: {},
    extraction: {},
  };
  await assert.rejects(
    () =>
      runEvaluation({
        dataset,
        fixtures: incompleteFixtures,
        mode: 'fixtures',
      }),
    /Invalid fixtures/
  );

  await assert.rejects(
    () =>
      runEvaluation({
        dataset,
        fixtures,
        mode: 'fixtures',
        filterTag: 'no-such-tag',
      }),
    /No cases matched/
  );
});

test('live mode fails fast when provider credentials are missing', async () => {
  const keys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'INTAKE_LLM_PROVIDER'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    await assert.rejects(
      () => runEvaluation({ dataset, mode: 'live' }),
      /Live evaluation requires/
    );
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('parseArgs supports repeatable modes and rejects unknown flags', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.mode, 'fixtures');
  assert.equal(defaults.delayMs, 0);
  assert.equal(defaults.failOnMiss, true);

  const live = parseArgs(['--live', '--verbose', '--no-fail-on-miss']);
  assert.equal(live.mode, 'live');
  assert.equal(live.delayMs, 250);
  assert.equal(live.failOnMiss, false);

  const filtered = parseArgs([
    '--fixtures=fixtures/custom.json',
    '--filter=enum_alias',
    '--out=out/report.md',
    '--delay-ms=10',
  ]);
  assert.equal(filtered.mode, 'fixtures');
  assert.equal(filtered.fixturesPath, 'fixtures/custom.json');
  assert.equal(filtered.filterTag, 'enum_alias');
  assert.equal(filtered.outPath, 'out/report.md');
  assert.equal(filtered.delayMs, 10);

  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.throws(() => parseArgs(['--delay-ms=-1']), /non-negative/);
});
