/**
 * eval.test.js
 *
 * Regression test that runs the full offline evaluation suite
 * (eval/runEval.js in fixture mode) and asserts every curated case passes.
 * This guards against regressions in the dataset, fixtures, normalizer,
 * routing validation, and extraction post-processing.
 *
 * No LLM provider or credentials are required.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const RUN_EVAL = path.join(__dirname, '..', 'modules', 'intake', 'eval', 'runEval.js');

test('offline evaluation suite passes all cases (exit code 0)', () => {
  let output;
  try {
    output = execFileSync(process.execPath, [RUN_EVAL], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    assert.fail(
      `eval/runEval.js exited with code ${err.status}.\n${err.stdout || ''}\n${
        err.stderr || ''
      }`,
    );
  }
  assert.ok(
    output.includes('Overall pass rate: 100.0%'),
    `Expected 100% pass rate. Output:\n${output}`,
  );
  assert.ok(output.includes('Failures: 0'), `Expected zero failures. Output:\n${output}`);
});

test('report file is generated after running eval', () => {
  execFileSync(process.execPath, [RUN_EVAL], { encoding: 'utf8' });
  const fs = require('fs');
  const reportPath = path.join(
    path.dirname(RUN_EVAL),
    'EVALUATION_REPORT.md',
  );
  assert.ok(fs.existsSync(reportPath), 'EVALUATION_REPORT.md was not generated.');
  const content = fs.readFileSync(reportPath, 'utf8');
  assert.ok(content.includes('Overall case pass rate'), 'Report missing summary table.');
  assert.ok(content.includes('100.0%'), 'Report missing 100% pass rate.');
});
