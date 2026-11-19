#!/usr/bin/env node
/**
 * runEval.js
 *
 * Repeatable evaluation runner for the AI Intake Pipeline.
 *
 * Modes:
 *   --fixtures (default)  Replay hand-authored model outputs through the real
 *                         routing/extraction/normalization code. Deterministic,
 *                         no API key needed. This validates pipeline logic and
 *                         protects against prompt/normalizer regressions.
 *   --live                Call the configured provider. Requires OPENROUTER_API_KEY (or OPENAI_API_KEY for the openai provider)
 *                         and incurs API cost. Results depend on the model,
 *                         model version, temperature, and provider state.
 *
 * Usage:
 *   node modules/intake/eval/runEval.js
 *   node modules/intake/eval/runEval.js --live --delay-ms=250
 *   node modules/intake/eval/runEval.js --fixtures=path/to/fixtures.json
 *   node modules/intake/eval/runEval.js --filter=enum_alias
 *
 * The runner writes EVALUATION_REPORT.md by default and exits non-zero when
 * any case fails (disable with --no-fail-on-miss).
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_DATASET_PATH,
  DEFAULT_FIXTURES_PATH,
  loadDataset,
  loadFixtures,
  validateDataset,
  validateFixtures,
} = require('./dataset');
const {
  evaluateRoutingCase,
  evaluateExtractionCase,
  aggregateResults,
} = require('./metrics');
const { RoutingService } = require('../services/routingService');
const {
  ExtractionService,
  createExtractionService,
} = require('../services/extractionService');
const { createExtractionChain } = require('../chains/extractionChain');
const { getProviderSummary, sleep } = require('../utils/llmProvider');
const { RunnableLambda } = require('@langchain/core/runnables');

const NO_RETRY = { maxRetries: 0, backoff: { initialMs: 0, maxMs: 0, factor: 1, jitterRatio: 0 } };

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'fixtures',
    datasetPath: DEFAULT_DATASET_PATH,
    fixturesPath: DEFAULT_FIXTURES_PATH,
    outPath: path.join(__dirname, 'EVALUATION_REPORT.md'),
    jsonOutPath: null,
    delayMs: null,
    filterTag: null,
    failOnMiss: true,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg === '--live') options.mode = 'live';
    else if (arg === '--fixtures') options.mode = 'fixtures';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--no-fail-on-miss') options.failOnMiss = false;
    else if (arg.startsWith('--dataset=')) options.datasetPath = arg.slice('--dataset='.length);
    else if (arg.startsWith('--fixtures=')) {
      options.mode = 'fixtures';
      options.fixturesPath = arg.slice('--fixtures='.length);
    } else if (arg.startsWith('--out=')) options.outPath = arg.slice('--out='.length);
    else if (arg.startsWith('--json-out=')) options.jsonOutPath = arg.slice('--json-out='.length);
    else if (arg.startsWith('--delay-ms=')) options.delayMs = Number(arg.slice('--delay-ms='.length));
    else if (arg.startsWith('--filter=')) options.filterTag = arg.slice('--filter='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.delayMs === null) options.delayMs = options.mode === 'live' ? 250 : 0;
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative number.');
  }

  return options;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Create a chat-model double whose structured-output call always returns the
 * supplied payload. It still goes through the real prompt and service code.
 *
 * @param {Object} payload
 * @returns {Object}
 */
function createStructuredDouble(payload) {
  return {
    invoke: async () => clone(payload),
    withStructuredOutput: () => RunnableLambda.from(async () => clone(payload)),
  };
}

/**
 * Build per-case services that replay a fixture model output.
 *
 * @param {Object} testCase
 * @param {Object} fixtures
 * @returns {Object} services
 */
function buildFixtureServices(testCase, fixtures) {
  const needsRouting =
    testCase.category === 'routing' || testCase.form_id === undefined;

  let routing;
  if (needsRouting) {
    const routingFixture = fixtures.routing?.[testCase.id];
    if (!routingFixture) {
      throw new Error(`No routing fixture for ${testCase.id}.`);
    }
    routing = new RoutingService({
      model: createStructuredDouble(routingFixture),
      retry: NO_RETRY,
    });
  } else {
    routing = {
      route: async () => {
        throw new Error(
          `Routing was unexpectedly called for explicit-form case ${testCase.id}.`
        );
      },
    };
  }

  if (testCase.category === 'routing') {
    return { routing, extraction: null };
  }

  const extractionFixture = fixtures.extraction?.[testCase.id];
  if (!extractionFixture) {
    throw new Error(`No extraction fixture for ${testCase.id}.`);
  }

  const extraction = new ExtractionService({
    routingService: routing,
    chainFactory: ({ schema }) =>
      createExtractionChain({
        schema,
        model: createStructuredDouble(extractionFixture),
        retry: NO_RETRY,
      }),
    reviewThreshold: 0.75,
    extractionModelName: 'fixture-baseline',
  });

  return { routing, extraction };
}

/**
 * Build services that call the live provider.
 * @returns {Object}
 */
function buildLiveServices() {
  const routingSummary = getProviderSummary('routing');
  const extractionSummary = getProviderSummary('extraction');

  if (!routingSummary.configured || !extractionSummary.configured) {
    throw new Error(
      'Live evaluation requires OPENROUTER_API_KEY and the configured OpenRouter base URL (or OPENAI_API_KEY for the openai provider) in the environment.'
    );
  }

  const routing = new RoutingService();
  const extraction = createExtractionService({ routingService: routing });
  return { routing, extraction };
}

async function runPipelineCase(testCase, services) {
  if (testCase.category === 'routing') {
    return services.routing.route({ userPrompt: testCase.text });
  }

  return services.extraction.extract({
    text: testCase.text,
    formId: testCase.form_id,
  });
}

/**
 * Run the dataset through a pipeline and score every case.
 *
 * @param {Object} params
 * @param {Object} params.dataset
 * @param {Object} [params.fixtures]
 * @param {'fixtures'|'live'} [params.mode]
 * @param {number} [params.delayMs]
 * @param {string|null} [params.filterTag]
 * @param {Function} [params.onProgress]
 * @returns {Promise<Object>}
 */
async function runEvaluation({
  dataset,
  fixtures,
  mode = 'fixtures',
  delayMs = 0,
  filterTag = null,
  onProgress,
} = {}) {
  const datasetCheck = validateDataset(dataset);
  if (datasetCheck.errors.length) {
    throw new Error(`Invalid dataset:\n- ${datasetCheck.errors.join('\n- ')}`);
  }

  if (mode === 'fixtures') {
    if (!fixtures) throw new Error('Fixture mode requires fixtures.');
    const fixtureCheck = validateFixtures(dataset, fixtures);
    if (fixtureCheck.errors.length) {
      throw new Error(
        `Invalid fixtures:\n- ${fixtureCheck.errors.join('\n- ')}`
      );
    }
  }

  const cases = (dataset.cases || []).filter(
    (testCase) => !filterTag || (testCase.tags || []).includes(filterTag)
  );

  if (!cases.length) {
    throw new Error(`No cases matched filter "${filterTag}".`);
  }

  const results = [];
  let services = null;
  if (mode === 'live') {
    services = buildLiveServices();
  }

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const caseServices =
      mode === 'fixtures' ? buildFixtureServices(testCase, fixtures) : services;

    let response;
    try {
      response = await runPipelineCase(testCase, caseServices);
    } catch (err) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        tags: testCase.tags || [],
        passed: false,
        checks: [
          {
            id: 'pipeline_error',
            pass: false,
            expected: 'successful pipeline response',
            actual: err.message,
          },
        ],
        assertions: [],
        contractViolations: [],
        counters: {},
        aliasCase: (testCase.tags || []).includes('enum_alias'),
        aliasPassed: false,
      });
      if (onProgress) onProgress({ index, total: cases.length, testCase, passed: false });
      if (delayMs) await sleep(delayMs);
      continue;
    }

    const result =
      testCase.category === 'routing'
        ? evaluateRoutingCase(testCase, response)
        : evaluateExtractionCase(testCase, response);

    results.push(result);

    if (onProgress) {
      onProgress({
        index,
        total: cases.length,
        testCase,
        passed: result.passed,
      });
    }

    if (delayMs) await sleep(delayMs);
  }

  const summary = aggregateResults(results);

  return {
    mode,
    dataset: {
      version: dataset.version,
      name: dataset.name,
      path: null,
      total_cases: dataset.cases.length,
      evaluated_cases: cases.length,
      filter_tag: filterTag,
    },
    model_info:
      mode === 'fixtures'
        ? {
            routing: 'fixture-baseline (deterministic model double)',
            extraction: 'fixture-baseline (deterministic model double)',
          }
        : {
            routing: getProviderSummary('routing'),
            extraction: getProviderSummary('extraction'),
          },
    summary,
    results,
  };
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value) {
  return String(value ?? 'null').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Render the Markdown evaluation report.
 *
 * @param {Object} evaluation
 * @param {Object} options
 * @returns {string}
 */
function renderReport(evaluation, options = {}) {
  const { summary, dataset, model_info: modelInfo, mode, results } = evaluation;
  const generatedAt = new Date().toISOString();
  const limitations = options.limitations || [];
  const lines = [];

  lines.push('# AI Intake Pipeline — Evaluation Report');
  lines.push('');
  lines.push(`- **Generated:** ${generatedAt}`);
  lines.push(
    `- **Mode:** ${
      mode === 'fixtures'
        ? 'Offline fixture replay (deterministic)'
        : 'Live provider run'
    }`
  );
  lines.push(
    `- **Dataset:** ${dataset.name || 'unnamed'} v${dataset.version || 'unversioned'}`
  );
  lines.push(
    `- **Cases:** ${dataset.evaluated_cases}${
      dataset.filter_tag ? ` (filter: ${dataset.filter_tag})` : ''
    } of ${dataset.total_cases}`
  );
  lines.push(
    `- **Routing model:** ${
      typeof modelInfo.routing === 'string'
        ? modelInfo.routing
        : `${modelInfo.routing.model} (${modelInfo.routing.provider})`
    }`
  );
  lines.push(
    `- **Extraction model:** ${
      typeof modelInfo.extraction === 'string'
        ? modelInfo.extraction
        : `${modelInfo.extraction.model} (${modelInfo.extraction.provider})`
    }`
  );
  lines.push('');

  if (mode === 'fixtures') {
    lines.push(
      '> **Mode note:** These numbers measure the deterministic pipeline (routing validation, normalization, provenance enforcement, null handling, review flags, and the evaluation harness) against reference model outputs. They are **not** live model-quality measurements. Run `--live` with provider credentials to measure the configured models.'
    );
  } else {
    lines.push(
      '> **Mode note:** These numbers reflect a single live run against the configured provider and model versions. Variance is expected across model snapshots, temperature, and retry conditions.'
    );
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Overall case pass rate | ${formatPercent(summary.case_pass_rate)} |`);
  lines.push(`| Routing accuracy | ${formatPercent(summary.routing.accuracy)} |`);
  lines.push(
    `| Field exact-match rate | ${formatPercent(summary.extraction.exact_match)} |`
  );
  lines.push(`| Field precision | ${formatPercent(summary.extraction.precision)} |`);
  lines.push(`| Field recall | ${formatPercent(summary.extraction.recall)} |`);
  lines.push(`| Field F1 | ${formatPercent(summary.extraction.f1)} |`);
  lines.push(
    `| Null accuracy (expected-null fields) | ${formatPercent(
      summary.extraction.null_accuracy
    )} |`
  );
  lines.push(
    `| Hallucination rate (non-null where null expected) | ${formatPercent(
      summary.extraction.hallucination_rate
    )} |`
  );
  lines.push(
    `| Provenance validity rate | ${formatPercent(
      summary.extraction.provenance_validity_rate
    )} |`
  );
  lines.push(
    `| Review-flag accuracy | ${formatPercent(
      summary.extraction.review_flag_accuracy
    )} |`
  );
  lines.push(
    `| Enum alias normalization accuracy | ${formatPercent(
      summary.extraction.alias_normalization_accuracy
    )} |`
  );
  lines.push(
    `| Schema violations | ${summary.extraction.schema_violations} |`
  );
  lines.push(
    `| Contract violations | ${summary.extraction.contract_violations} |`
  );
  lines.push('');

  lines.push('## Case counts');
  lines.push('');
  lines.push('| Category | Cases | Passed | Failed |');
  lines.push('|---|---:|---:|---:|');
  lines.push(
    `| Routing | ${summary.totals.routing_cases} | ${summary.routing.passed} | ${
      summary.totals.routing_cases - summary.routing.passed
    } |`
  );
  lines.push(
    `| Extraction | ${summary.totals.extraction_cases} | ${summary.extraction.passed} | ${
      summary.totals.extraction_cases - summary.extraction.passed
    } |`
  );
  lines.push(
    `| **Total** | **${summary.totals.cases}** | **${summary.totals.passed}** | **${summary.totals.failed}** |`
  );
  lines.push('');

  lines.push('## Extraction details');
  lines.push('');
  lines.push('| Counter | Value |');
  lines.push('|---|---:|');
  lines.push(
    `| Asserted fields | ${summary.extraction.assertions} |`
  );
  lines.push(
    `| Expected non-null fields | ${summary.extraction.expected_positives} |`
  );
  lines.push(
    `| Predicted non-null fields | ${summary.extraction.predicted_positives} |`
  );
  lines.push(`| True positives | ${summary.extraction.true_positives} |`);
  lines.push(`| False positives | ${summary.extraction.false_positives} |`);
  lines.push(`| False negatives | ${summary.extraction.false_negatives} |`);
  lines.push(`| Expected-null assertions | ${summary.extraction.expected_nulls} |`);
  lines.push('');

  lines.push('## Failure examples');
  lines.push('');
  if (!summary.failures.length) {
    lines.push('No failing cases in this run.');
  } else {
    const failures = summary.failures.slice(0, 25);
    lines.push('| Case | Category | Failed check | Expected | Actual |');
    lines.push('|---|---|---|---|---|');
    for (const failure of failures) {
      const failed = failure.failed_checks.length
        ? failure.failed_checks
        : [{ check: 'contract', expected: 'valid contract', actual: 'violation' }];
      for (const check of failed) {
        lines.push(
          `| ${escapeCell(failure.id)} | ${failure.category} | ${escapeCell(
            check.check
          )} | ${escapeCell(check.expected)} | ${escapeCell(check.actual)} |`
        );
      }
      for (const violation of failure.contract_violations) {
        lines.push(
          `| ${escapeCell(failure.id)} | ${failure.category} | contract:${escapeCell(
            violation.kind
          )} | — | ${escapeCell(violation.detail || violation.path)} |`
        );
      }
    }
    if (summary.failures.length > failures.length) {
      lines.push('');
      lines.push(
        `> Showing the first ${failures.length} of ${summary.failures.length} failing cases.`
      );
    }
  }
  lines.push('');

  const tagCounts = new Map();
  for (const result of results) {
    for (const tag of result.tags || []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  if (tagCounts.size) {
    lines.push('## Coverage tags');
    lines.push('');
    lines.push('| Tag | Cases |');
    lines.push('|---|---:|');
    for (const [tag, count] of [...tagCounts.entries()].sort()) {
      lines.push(`| ${tag} | ${count} |`);
    }
    lines.push('');
  }

  lines.push('## Known limitations');
  lines.push('');
  for (const limitation of limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');

  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('# Deterministic pipeline regression run (no API key required)');
  lines.push('cd server && npm run eval');
  lines.push('');
  lines.push('# Live provider run (requires OPENROUTER_API_KEY; free-tier models may be rate-limited)');
  lines.push('cd server && node modules/intake/eval/runEval.js --live --delay-ms=250');
  lines.push('');
  lines.push('# Focused run');
  lines.push('cd server && node modules/intake/eval/runEval.js --filter=enum_alias');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(`AI Intake evaluation runner

  --live                 Call the configured provider (requires OPENROUTER_API_KEY)
  --fixtures=<path>      Use a specific fixture file (default: eval/fixtures/baseline.json)
  --dataset=<path>       Use a specific dataset file (default: eval/dataset.json)
  --out=<path>           Report output path (default: eval/EVALUATION_REPORT.md)
  --json-out=<path>      Optional machine-readable summary path
  --filter=<tag>         Only run cases with this tag
  --delay-ms=<n>         Delay between live calls (default 250 live, 0 fixtures)
  --no-fail-on-miss      Exit 0 even when a case fails
`);
    return 0;
  }

  const dataset = loadDataset(options.datasetPath);
  const fixtures =
    options.mode === 'fixtures' ? loadFixtures(options.fixturesPath) : undefined;

  console.log(
    `Running ${dataset.cases.length} intake evaluation cases in ${
      options.mode === 'fixtures' ? 'fixture' : 'live'
    } mode...`
  );

  const evaluation = await runEvaluation({
    dataset,
    fixtures,
    mode: options.mode,
    delayMs: options.delayMs,
    filterTag: options.filterTag,
    onProgress: ({ index, total, testCase, passed }) => {
      if (options.verbose || !passed) {
        console.log(
          `[${index + 1}/${total}] ${passed ? 'PASS' : 'FAIL'} ${testCase.id}`
        );
      }
    },
  });

  evaluation.dataset.path = options.datasetPath;

  const report = renderReport(evaluation, {
    limitations: dataset.limitations || [],
  });

  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  fs.writeFileSync(options.outPath, report, 'utf8');

  if (options.jsonOutPath) {
    fs.mkdirSync(path.dirname(options.jsonOutPath), { recursive: true });
    fs.writeFileSync(
      options.jsonOutPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          mode: evaluation.mode,
          dataset: evaluation.dataset,
          model_info: evaluation.model_info,
          summary: evaluation.summary,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  console.log('');
  console.log(`Overall pass rate: ${formatPercent(evaluation.summary.case_pass_rate)}`);
  console.log(`Routing accuracy: ${formatPercent(evaluation.summary.routing.accuracy)}`);
  console.log(
    `Extraction exact match: ${formatPercent(
      evaluation.summary.extraction.exact_match
    )}`
  );
  console.log(
    `Hallucination rate: ${formatPercent(
      evaluation.summary.extraction.hallucination_rate
    )}`
  );
  console.log(`Schema violations: ${evaluation.summary.extraction.schema_violations}`);
  console.log(`Failures: ${evaluation.summary.failures.length}`);
  console.log(`Report: ${options.outPath}`);

  if (evaluation.summary.failures.length) {
    console.log('');
    console.log('Failing cases:');
    for (const failure of evaluation.summary.failures.slice(0, 10)) {
      console.log(`- ${failure.id}`);
      for (const check of failure.failed_checks.slice(0, 4)) {
        console.log(
          `    ${check.check}: expected ${JSON.stringify(
            check.expected
          )}, got ${JSON.stringify(check.actual)}`
        );
      }
    }
  }

  if (options.failOnMiss && evaluation.summary.failures.length) {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`Evaluation failed: ${err.message}`);
      if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  createStructuredDouble,
  buildFixtureServices,
  buildLiveServices,
  runPipelineCase,
  runEvaluation,
  renderReport,
  formatPercent,
  main,
};
