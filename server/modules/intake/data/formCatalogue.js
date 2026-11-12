/**
 * formCatalogue.js
 *
 * Static catalogue of supported intake forms for the AI Intake Pipeline.
 * Each entry describes one form the router may classify a user prompt against.
 *
 * Fields:
 *   form_id             - Unique identifier used in routing decisions.
 *   display_name        - Human-readable name of the form.
 *   description         - Concise summary of what the form handles; used for
 *                         LLM classification matching.
 *   schema_reference_id - Identifier pointing to the field schema for this form.
 */

const formCatalogue = [
  {
    form_id: 'FORM_PATENT_INTAKE',
    display_name: 'Patent Application Intake',
    description:
      'Handles new patent application submissions, prior art disclosures, inventor details, and prior-art searches for utility, design, and plant patents.',
    schema_reference_id: 'SCHEMA_PATENT_FIELDS',
  },
  {
    form_id: 'FORM_TAX_FILING',
    display_name: 'Tax Filing Intake',
    description:
      'Handles individual and business tax return preparation and filing, filing status, income reporting, deductions, credits, and tax payment or extension inquiries.',
    schema_reference_id: 'SCHEMA_TAX_FIELDS',
  },
  {
    form_id: 'FORM_EMPLOYEE_ONBOARDING',
    display_name: 'Employee Onboarding Intake',
    description:
      'Handles new hire paperwork, employment contracts, tax withholding forms, benefits enrollment, and equipment provisioning for new employees.',
    schema_reference_id: 'SCHEMA_ONBOARDING_FIELDS',
  },
  {
    form_id: 'FORM_INSURANCE_CLAIM',
    display_name: 'Insurance Claim Intake',
    description:
      'Handles insurance claim submissions, loss or damage reports, policy coverage questions, and claim status follow-ups.',
    schema_reference_id: 'SCHEMA_CLAIM_FIELDS',
  },
  {
    form_id: 'FORM_SUPPORT_TICKET',
    display_name: 'General Support Intake',
    description:
      'Handles general customer support requests, account access issues, product troubleshooting, and feature inquiries that do not fit a specialized form.',
    schema_reference_id: 'SCHEMA_SUPPORT_FIELDS',
  },
];

/**
 * Return the full catalogue array.
 * @returns {Array<Object>}
 */
function getAllForms() {
  return formCatalogue;
}

/**
 * Find a catalogue entry by form_id.
 * @param {string} formId
 * @returns {Object|undefined}
 */
function findById(formId) {
  return formCatalogue.find((entry) => entry.form_id === formId);
}

/**
 * Return the catalogue rendered as a compact text block for injection into
 * the routing system prompt.
 * @returns {string}
 */
function catalogueText() {
  return formCatalogue
    .map(
      (entry) =>
        `- ${entry.form_id}: ${entry.display_name} — ${entry.description} (schema: ${entry.schema_reference_id})`
    )
    .join('\n');
}

module.exports = {
  formCatalogue,
  getAllForms,
  findById,
  catalogueText,
};
