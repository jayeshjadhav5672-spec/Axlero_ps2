const {
  catalogueText,
  findById,
  formCatalogue,
  getAllForms,
} = require('../modules/intake/data/formCatalogue');
const { describe, expect, test } = require('@jest/globals');

describe('form catalogue', () => {
  test('exports a non-empty array of form definitions', () => {
    expect(Array.isArray(formCatalogue)).toBe(true);
    expect(formCatalogue.length).toBeGreaterThan(0);
    expect(Array.isArray(getAllForms())).toBe(true);
    expect(getAllForms()).toEqual(formCatalogue);
  });

  test('every entry has the required non-empty fields', () => {
    for (const entry of formCatalogue) {
      expect(typeof entry.form_id).toBe('string');
      expect(entry.form_id.trim().length).toBeGreaterThan(0);

      expect(typeof entry.display_name).toBe('string');
      expect(entry.display_name.trim().length).toBeGreaterThan(0);

      expect(typeof entry.description).toBe('string');
      expect(entry.description.trim().length).toBeGreaterThan(0);

      expect(typeof entry.schema_reference_id).toBe('string');
      expect(entry.schema_reference_id.trim().length).toBeGreaterThan(0);
    }
  });

  test('form identifiers and schema references are unique', () => {
    const formIds = formCatalogue.map((entry) => entry.form_id);
    const schemaIds = formCatalogue.map((entry) => entry.schema_reference_id);

    expect(new Set(formIds).size).toBe(formCatalogue.length);
    expect(new Set(schemaIds).size).toBe(formCatalogue.length);
  });

  test('findById returns the matching catalogue entry', () => {
    const entry = formCatalogue[0];

    expect(findById(entry.form_id)).toBe(entry);
  });

  test('findById returns undefined for an unknown form identifier', () => {
    expect(findById('FORM_DOES_NOT_EXIST')).toBeUndefined();
  });

  test('catalogueText includes every catalogue entry', () => {
    const text = catalogueText();
    const lines = text.split('\n');

    expect(lines).toHaveLength(formCatalogue.length);

    for (const entry of formCatalogue) {
      const matchingLine = lines.find((line) => line.includes(entry.form_id));

      expect(matchingLine).toBeDefined();
      expect(matchingLine.startsWith('- ')).toBe(true);
      expect(text).toContain(entry.display_name);
      expect(text).toContain(entry.description);
      expect(text).toContain(entry.schema_reference_id);
    }
  });
});
