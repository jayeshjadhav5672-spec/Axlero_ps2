const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formSchemas,
  getAllSchemas,
  getSchemaByFormId,
  getSchemaById,
  getSupportedFormIds,
  describeSchemaForPrompt,
} = require('../modules/intake/data/formSchemas');
const {
  formCatalogue,
  getAllForms,
} = require('../modules/intake/data/formCatalogue');
const { normalizeEnumKey } = require('../modules/intake/utils/normalizer');

test('every catalogue form has a matching field schema', () => {
  assert.equal(getAllForms().length, formCatalogue.length);

  for (const entry of getAllForms()) {
    const schema = getSchemaById(entry.schema_reference_id);
    assert.ok(schema, `Missing schema ${entry.schema_reference_id}`);
    assert.equal(schema.form_id, entry.form_id);
    assert.equal(schema.schema_reference_id, entry.schema_reference_id);
    assert.equal(getSchemaByFormId(entry.form_id), schema);
    assert.ok(schema.fields.length > 0, `${entry.form_id} has no fields`);
  }

  assert.deepEqual(
    new Set(getSupportedFormIds()),
    new Set(getAllForms().map((entry) => entry.form_id))
  );
});

test('field definitions are complete and uniquely keyed within a form', () => {
  const allowedTypes = new Set(['string', 'number', 'boolean', 'date', 'enum']);

  for (const schema of getAllSchemas()) {
    const paths = new Set();
    for (const field of schema.fields) {
      assert.equal(typeof field.path, 'string');
      assert.ok(field.path.length > 0);
      assert.equal(paths.has(field.path), false, `Duplicate ${field.path}`);
      paths.add(field.path);

      assert.equal(allowedTypes.has(field.type), true, `Bad type ${field.type}`);
      assert.equal(typeof field.description, 'string');
      assert.ok(field.description.length >= 10);
      assert.equal(typeof field.required, 'boolean');

      if (field.type === 'enum') {
        assert.ok(Array.isArray(field.enum) && field.enum.length > 1);
        assert.equal(new Set(field.enum).size, field.enum.length);

        const aliasKeys = new Map();
        for (const canonical of field.enum) {
          for (const alias of field.aliases?.[canonical] || []) {
            assert.equal(
              field.enum.includes(canonical),
              true,
              `Alias target ${canonical} is not in enum`
            );
            const key = normalizeEnumKey(alias);
            if (aliasKeys.has(key) && aliasKeys.get(key) !== canonical) {
              assert.fail(
                `Alias "${alias}" maps to both ${aliasKeys.get(key)} and ${canonical} in ${field.path}`
              );
            }
            aliasKeys.set(key, canonical);
          }
        }

        for (const key of Object.keys(field.aliases || {})) {
          assert.equal(
            field.enum.includes(key),
            true,
            `Alias bucket ${key} is not an allowed enum value`
          );
        }
      } else {
        assert.equal(field.enum, undefined);
        assert.equal(field.aliases, undefined);
      }

      if (field.type === 'number') {
        if (field.min !== undefined) assert.equal(Number.isFinite(field.min), true);
        if (field.max !== undefined) assert.equal(Number.isFinite(field.max), true);
      }
    }
  }
});

test('prompt rendering includes paths, types, enums, aliases, and descriptions', () => {
  const schema = getSchemaByFormId('FORM_TAX_FILING');
  const text = describeSchemaForPrompt(schema);

  for (const field of schema.fields) {
    assert.ok(text.includes(field.path));
    assert.ok(text.includes(field.type));
    assert.ok(text.includes(field.description));
  }
  assert.ok(text.includes('married_filing_jointly'));
  assert.ok(text.includes('mfj'));
  assert.ok(text.includes('integer: yes'));
  assert.equal(text.includes('{'), false);
  assert.equal(text.includes('}'), false);
});

test('formSchemas object is keyed by schema_reference_id', () => {
  for (const [key, schema] of Object.entries(formSchemas)) {
    assert.equal(key, schema.schema_reference_id);
  }
});
