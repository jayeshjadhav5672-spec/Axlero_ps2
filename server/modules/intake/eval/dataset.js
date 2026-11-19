/**
 * dataset.js
 *
 * Loading and validation for the evaluation dataset and reference fixtures.
 * Validation runs before scoring so malformed expectations cannot silently
 * produce a meaningless "pass".
 */

const fs = require('fs');
const path = require('path');
const {
  getSchemaByFormId,
  getSupportedFormIds,
} = require('../data/formSchemas');
const { isValueInSchema } = require('../utils/normalizer');

const DEFAULT_DATASET_PATH = path.join(__dirname, 'dataset.json');
const DEFAULT_FIXTURES_PATH = path.join(__dirname, 'fixtures', 'baseline.json');

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

function loadDataset(filePath = DEFAULT_DATASET_PATH) {
  return loadJson(filePath);
}

function loadFixtures(filePath = DEFAULT_FIXTURES_PATH) {
  return loadJson(filePath);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate dataset structure and every expectation against the form schemas.
 *
 * @param {Object} dataset
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateDataset(dataset) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(dataset)) {
    return { errors: ['Dataset root must be an object.'], warnings };
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    errors.push('Dataset must contain a non-empty cases array.');
    return { errors, warnings };
  }

  if (!dataset.version) warnings.push('Dataset has no version field.');
  if (!Array.isArray(dataset.limitations) || dataset.limitations.length === 0) {
    warnings.push('Dataset has no limitations list.');
  }

  const supportedForms = new Set(getSupportedFormIds());
  const seenIds = new Set();
  const categories = new Set();

  dataset.cases.forEach((testCase, index) => {
    const prefix = `cases[${index}]`;

    if (!isPlainObject(testCase)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }

    if (!testCase.id || typeof testCase.id !== 'string') {
      errors.push(`${prefix}.id must be a non-empty string.`);
    } else if (seenIds.has(testCase.id)) {
      errors.push(`Duplicate case id: ${testCase.id}`);
    } else {
      seenIds.add(testCase.id);
    }

    if (!['routing', 'extraction'].includes(testCase.category)) {
      errors.push(`${prefix}.category must be "routing" or "extraction".`);
      return;
    }
    categories.add(testCase.category);

    if (typeof testCase.text !== 'string') {
      errors.push(`${prefix}.text must be a string.`);
      return;
    }

    if (!Array.isArray(testCase.tags)) {
      errors.push(`${prefix}.tags must be an array.`);
    }

    if (testCase.category === 'routing') {
      const expected = testCase.expected;
      if (!isPlainObject(expected)) {
        errors.push(`${prefix}.expected must be an object.`);
        return;
      }
      if (
        expected.form_id !== null &&
        !supportedForms.has(expected.form_id)
      ) {
        errors.push(
          `${prefix}.expected.form_id "${expected.form_id}" is not a supported form.`
        );
      }
      if (typeof expected.clarification_required !== 'boolean') {
        errors.push(
          `${prefix}.expected.clarification_required must be a boolean.`
        );
      }
      return;
    }

    // Extraction cases
    if (testCase.form_id !== undefined && !supportedForms.has(testCase.form_id)) {
      errors.push(
        `${prefix}.form_id "${testCase.form_id}" is not a supported form.`
      );
    }

    const expected = testCase.expected;
    if (!isPlainObject(expected)) {
      errors.push(`${prefix}.expected must be an object.`);
      return;
    }

    const formId = expected.form_id || testCase.form_id;
    if (!supportedForms.has(formId)) {
      errors.push(
        `${prefix} must reference a supported expected.form_id or form_id.`
      );
      return;
    }

    const schema = getSchemaByFormId(formId);
    const fields = schema ? schema.fields : [];
    const fieldMap = new Map(fields.map((field) => [field.path, field]));

    if (!isPlainObject(expected.fields)) {
      errors.push(`${prefix}.expected.fields must be an object.`);
      return;
    }

    for (const [fieldPath, expectedValue] of Object.entries(expected.fields)) {
      const field = fieldMap.get(fieldPath);
      if (!field) {
        errors.push(
          `${prefix}.expected.fields.${fieldPath} is not in ${formId}'s schema.`
        );
        continue;
      }
      if (expectedValue !== null && !isValueInSchema(field, expectedValue)) {
        errors.push(
          `${prefix}.expected.fields.${fieldPath} value ${JSON.stringify(
            expectedValue
          )} does not conform to schema type ${field.type}.`
        );
      }
    }

    for (const key of ['review_required', 'review_not_required']) {
      if (expected[key] === undefined) continue;
      if (!Array.isArray(expected[key])) {
        errors.push(`${prefix}.expected.${key} must be an array.`);
        continue;
      }
      for (const fieldPath of expected[key]) {
        if (!fieldMap.has(fieldPath)) {
          errors.push(
            `${prefix}.expected.${key} references unknown field "${fieldPath}".`
          );
        }
      }
    }

    const required = new Set(expected.review_required || []);
    const notRequired = new Set(expected.review_not_required || []);
    for (const fieldPath of required) {
      if (notRequired.has(fieldPath)) {
        errors.push(
          `${prefix}.expected lists "${fieldPath}" as both review_required and review_not_required.`
        );
      }
    }
  });

  if (!categories.has('routing')) errors.push('Dataset has no routing cases.');
  if (!categories.has('extraction')) {
    errors.push('Dataset has no extraction cases.');
  }

  return { errors, warnings };
}

/**
 * Validate that fixtures cover every case and have the expected basic shape.
 * Fixture *values* may deliberately be wrong (for example an unsupported
 * enum) because the pipeline is expected to reject them.
 *
 * @param {Object} dataset
 * @param {Object} fixtures
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateFixtures(dataset, fixtures) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(fixtures)) {
    return { errors: ['Fixtures root must be an object.'], warnings };
  }
  if (!isPlainObject(fixtures.routing)) {
    errors.push('Fixtures must contain a routing object.');
  }
  if (!isPlainObject(fixtures.extraction)) {
    errors.push('Fixtures must contain an extraction object.');
  }

  const supportedForms = new Set(getSupportedFormIds());

  for (const testCase of dataset.cases || []) {
    if (testCase.category === 'routing') {
      const fixture = fixtures.routing?.[testCase.id];
      if (!isPlainObject(fixture)) {
        errors.push(`Missing routing fixture for ${testCase.id}.`);
        continue;
      }
      if (fixture.form_id !== null && !supportedForms.has(fixture.form_id)) {
        errors.push(
          `Routing fixture ${testCase.id} has unsupported form_id "${fixture.form_id}".`
        );
      }
      if (
        typeof fixture.confidence !== 'number' ||
        fixture.confidence < 0 ||
        fixture.confidence > 1
      ) {
        errors.push(`Routing fixture ${testCase.id} has invalid confidence.`);
      }
      if (typeof fixture.clarification_required !== 'boolean') {
        errors.push(
          `Routing fixture ${testCase.id} must include a boolean clarification_required.`
        );
      }
      if (typeof fixture.rationale !== 'string') {
        errors.push(`Routing fixture ${testCase.id} must include a rationale.`);
      }
      continue;
    }

    const fixture = fixtures.extraction?.[testCase.id];
    if (!isPlainObject(fixture)) {
      errors.push(`Missing extraction fixture for ${testCase.id}.`);
      continue;
    }

    for (const [fieldPath, entry] of Object.entries(fixture)) {
      if (!isPlainObject(entry)) {
        errors.push(
          `Extraction fixture ${testCase.id}.${fieldPath} must be an object.`
        );
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(entry, 'value')) {
        errors.push(
          `Extraction fixture ${testCase.id}.${fieldPath} is missing value.`
        );
      }
      if (
        typeof entry.confidence !== 'number' ||
        entry.confidence < 0 ||
        entry.confidence > 1
      ) {
        errors.push(
          `Extraction fixture ${testCase.id}.${fieldPath} has invalid confidence.`
        );
      }
    }

    if (testCase.form_id === undefined) {
      const routeFixture = fixtures.routing?.[testCase.id];
      if (!isPlainObject(routeFixture)) {
        errors.push(
          `Auto-routed extraction case ${testCase.id} needs a routing fixture.`
        );
      } else if (
        testCase.expected?.form_id &&
        routeFixture.form_id !== testCase.expected.form_id
      ) {
        errors.push(
          `Auto-routed extraction case ${testCase.id} routing fixture returns "${routeFixture.form_id}", expected "${testCase.expected.form_id}".`
        );
      }
    }
  }

  if (!fixtures.description) {
    warnings.push('Fixtures have no description/label.');
  }

  return { errors, warnings };
}

module.exports = {
  DEFAULT_DATASET_PATH,
  DEFAULT_FIXTURES_PATH,
  loadJson,
  loadDataset,
  loadFixtures,
  validateDataset,
  validateFixtures,
};
