const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeValue,
  normalizeDate,
  matchEnum,
  resolveProvenance,
  isValueInSchema,
  normalizeEnumKey,
} = require('../modules/intake/utils/normalizer');
const { getSchemaByFormId } = require('../modules/intake/data/formSchemas');

function field(formId, path) {
  const schema = getSchemaByFormId(formId);
  return schema.fields.find((entry) => entry.path === path);
}

test('enum aliases map to canonical values and are flagged for review', () => {
  const filingStatus = field('FORM_TAX_FILING', 'filing_status');

  const alias = normalizeValue(filingStatus, 'MFJ');
  assert.equal(alias.value, 'married_filing_jointly');
  assert.equal(alias.aliasMapped, true);

  const canonical = normalizeValue(filingStatus, 'Married Filing Jointly');
  assert.equal(canonical.value, 'married_filing_jointly');
  assert.equal(canonical.aliasMapped, false);

  const underscores = normalizeValue(filingStatus, 'head_of_household');
  assert.equal(underscores.value, 'head_of_household');
  assert.equal(underscores.aliasMapped, false);

  const spouse = normalizeValue(filingStatus, 'surviving spouse');
  assert.equal(spouse.value, 'qualifying_surviving_spouse');
  assert.equal(spouse.aliasMapped, true);
});

test('unsupported enum values return null instead of a closest match', () => {
  const patentType = field('FORM_PATENT_INTAKE', 'patent_type');

  const provisional = normalizeValue(patentType, 'provisional');
  assert.equal(provisional.value, null);
  assert.equal(provisional.ok, false);
  assert.equal(provisional.reason, 'enum_not_allowed');

  const fuzzy = normalizeValue(patentType, 'utilitarian');
  assert.equal(fuzzy.value, null);
  assert.equal(fuzzy.reason, 'enum_not_allowed');

  const claimType = field('FORM_INSURANCE_CLAIM', 'claim_type');
  const marine = normalizeValue(claimType, 'marine');
  assert.equal(marine.value, null);
  assert.equal(marine.reason, 'enum_not_allowed');
});

test('ambiguous aliases are rejected rather than guessed', () => {
  const ambiguousField = {
    path: 'value',
    type: 'enum',
    enum: ['first', 'second'],
    aliases: { first: ['shared'], second: ['shared'] },
  };

  const result = matchEnum(ambiguousField, 'Shared');
  assert.equal(result.value, null);
  assert.equal(result.reason, 'ambiguous_alias');
});

test('string normalization trims, collapses whitespace, and rejects empty values', () => {
  const name = field('FORM_EMPLOYEE_ONBOARDING', 'employee_name');

  assert.equal(normalizeValue(name, '  Priya   Raman ').value, 'Priya Raman');
  assert.equal(normalizeValue(name, '"Priya Raman"').value, 'Priya Raman');
  assert.equal(normalizeValue(name, '   ').value, null);
  assert.equal(normalizeValue(name, null).value, null);
  assert.equal(normalizeValue(name, { name: 'x' }).value, null);

  const policy = field('FORM_INSURANCE_CLAIM', 'policy_number');
  assert.equal(normalizeValue(policy, 12345).value, '12345');
});

test('number normalization handles commas/currency but rejects words and invalid ranges', () => {
  const amount = field('FORM_INSURANCE_CLAIM', 'estimated_loss_amount');
  assert.equal(normalizeValue(amount, '$12,500').value, 12500);
  assert.equal(normalizeValue(amount, 'USD 12,500').value, 12500);
  assert.equal(normalizeValue(amount, '12500').value, 12500);
  assert.equal(normalizeValue(amount, '40,000 dollars').value, null);
  assert.equal(normalizeValue(amount, 'about twelve thousand').value, null);
  assert.equal(normalizeValue(amount, -5).value, null);

  const dependents = field('FORM_TAX_FILING', 'dependents_count');
  assert.equal(normalizeValue(dependents, 2).value, 2);
  assert.equal(normalizeValue(dependents, 2.5).value, null);
  assert.equal(normalizeValue(dependents, -1).value, null);

  const year = field('FORM_TAX_FILING', 'tax_year');
  assert.equal(normalizeValue(year, 1899).value, null);
  assert.equal(normalizeValue(year, 2101).value, null);
});

test('boolean normalization accepts explicit yes/no forms only', () => {
  const extension = field('FORM_TAX_FILING', 'needs_extension');

  assert.equal(normalizeValue(extension, true).value, true);
  assert.equal(normalizeValue(extension, 'yes').value, true);
  assert.equal(normalizeValue(extension, 'no').value, false);
  assert.equal(normalizeValue(extension, '0').value, false);
  assert.equal(normalizeValue(extension, 'maybe').value, null);
  assert.equal(normalizeValue(extension, 'filed').value, null);
});

test('date normalization accepts explicit formats and rejects ambiguous ones', () => {
  assert.deepEqual(normalizeDate('2026-03-03'), {
    value: '2026-03-03',
    ok: true,
    reason: null,
  });
  assert.deepEqual(normalizeDate('March 3, 2026'), {
    value: '2026-03-03',
    ok: true,
    reason: null,
  });
  assert.deepEqual(normalizeDate('15 January 2026'), {
    value: '2026-01-15',
    ok: true,
    reason: null,
  });
  assert.equal(normalizeDate('03/04/2026').value, null);
  assert.equal(normalizeDate('2026-02-30').value, null);
  assert.equal(normalizeDate('next month').value, null);
  assert.equal(normalizeDate(20260303).value, null);
});

test('isValueInSchema enforces exact types and enum membership', () => {
  const filingStatus = field('FORM_TAX_FILING', 'filing_status');
  assert.equal(isValueInSchema(filingStatus, 'single'), true);
  assert.equal(isValueInSchema(filingStatus, 'Single'), false);
  assert.equal(isValueInSchema(filingStatus, 'mfj'), false);

  const date = field('FORM_EMPLOYEE_ONBOARDING', 'start_date');
  assert.equal(isValueInSchema(date, '2026-03-03'), true);
  assert.equal(isValueInSchema(date, '2026-2-3'), false);
  assert.equal(isValueInSchema(date, '2026-02-30'), false);

  const count = field('FORM_SUPPORT_TICKET', 'affected_users_count');
  assert.equal(isValueInSchema(count, 3), true);
  assert.equal(isValueInSchema(count, 3.5), false);
  assert.equal(isValueInSchema(count, 0), false);
});

test('provenance must be a verbatim source snippet', () => {
  const source =
    'My filing status is married filing jointly.\nI have 2 dependents.';

  assert.deepEqual(resolveProvenance('married filing jointly', source), {
    ok: true,
    quote: 'married filing jointly',
    reason: null,
  });

  // Newline/whitespace differences are repaired to the actual source snippet.
  const repaired = resolveProvenance(
    'married filing jointly. I have 2 dependents.',
    source
  );
  assert.equal(repaired.ok, true);
  assert.equal(repaired.quote, 'married filing jointly.\nI have 2 dependents.');

  assert.equal(resolveProvenance('single', source).ok, false);
  assert.equal(
    resolveProvenance('single', source).reason,
    'provenance_not_in_source'
  );
  // A quote embedded inside a larger token is not valid provenance.
  assert.equal(resolveProvenance('2 dependents', 'I have 12 dependents.').ok, false);
  assert.equal(resolveProvenance('and', 'a sandwich').ok, false);
  assert.equal(resolveProvenance('2 dependents', 'I have 2 dependents.').ok, true);
  assert.equal(resolveProvenance(null, source).reason, 'missing_provenance');
  assert.equal(resolveProvenance('   ', source).reason, 'missing_provenance');
  assert.equal(resolveProvenance('!!!', source).reason, 'uninformative_provenance');
  assert.equal(resolveProvenance('anything', '').reason, 'missing_source_text');
});

test('normalizeEnumKey collapses punctuation and separators without fuzzy matching', () => {
  assert.equal(normalizeEnumKey('Married Filing Jointly'), 'married filing jointly');
  assert.equal(normalizeEnumKey('head-of-household'), 'head of household');
  assert.equal(normalizeEnumKey('W-2'), 'w 2');
  assert.equal(normalizeEnumKey('  (MFJ).  '), 'mfj');
});
