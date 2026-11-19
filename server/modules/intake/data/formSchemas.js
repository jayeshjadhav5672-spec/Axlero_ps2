/**
 * formSchemas.js
 *
 * Field schemas for every form in the intake catalogue.
 *
 * Each schema is keyed by `schema_reference_id` (see formCatalogue.js) and
 * describes the exact fields the extraction pipeline may return. A field
 * definition includes:
 *
 *   path        - Dot-free field path used in the extraction response.
 *   type        - One of: string | number | boolean | date | enum.
 *   description - Instruction for the extraction model (what counts as
 *                 evidence for this field).
 *   required    - Whether the field is normally required. Extraction still
 *                 returns null when evidence is missing.
 *   enum        - Allowed values (enum fields only).
 *   aliases     - Map of canonical value -> accepted synonyms. Aliases may
 *                 only point at values that are already in `enum`.
 *   integer     - Reject non-integers (number fields only).
 *   min/max     - Numeric bounds (number fields only).
 *
 * Aliases are deliberately finite and exact-after-normalization. The
 * normalizer never guesses at values outside this schema.
 */

const formSchemas = {
  SCHEMA_PATENT_FIELDS: {
    schema_reference_id: 'SCHEMA_PATENT_FIELDS',
    form_id: 'FORM_PATENT_INTAKE',
    display_name: 'Patent Application Intake',
    fields: [
      {
        path: 'invention_title',
        type: 'string',
        required: true,
        description:
          'Short title or name of the invention exactly as the user describes it. Do not invent a marketing title.',
      },
      {
        path: 'patent_type',
        type: 'enum',
        required: true,
        enum: ['utility', 'design', 'plant'],
        aliases: {
          utility: ['utility patent', 'non-provisional', 'nonprovisional', 'regular patent'],
          design: ['design patent', 'ornamental design'],
          plant: ['plant patent', 'plant variety'],
        },
        description:
          'Type of patent requested. Only utility, design, and plant patents are supported. A provisional application is NOT one of the allowed values.',
      },
      {
        path: 'inventor_name',
        type: 'string',
        required: true,
        description:
          'Full name of the primary inventor as stated by the user. Do not infer a name from an email address or company.',
      },
      {
        path: 'applicant_type',
        type: 'enum',
        required: false,
        enum: ['individual', 'company', 'university', 'government'],
        aliases: {
          individual: ['person', 'sole inventor', 'individual applicant', 'private person'],
          company: ['corporation', 'corp', 'business entity', 'company applicant', 'llc', 'inc'],
          university: ['college', 'academic institution', 'university applicant', 'research institution'],
          government: ['govt', 'government agency', 'federal agency', 'public institution'],
        },
        description:
          'Who is applying for the patent: an individual, company, university, or government body.',
      },
      {
        path: 'technical_field',
        type: 'string',
        required: false,
        description:
          'Field of technology, industry, or domain the invention relates to (for example: water treatment, robotics, furniture).',
      },
      {
        path: 'prior_art_disclosed',
        type: 'boolean',
        required: false,
        description:
          'True only if the user states that prior art has already been identified or disclosed. False if they explicitly state no prior art work has been done. Null if unstated.',
      },
    ],
  },

  SCHEMA_TAX_FIELDS: {
    schema_reference_id: 'SCHEMA_TAX_FIELDS',
    form_id: 'FORM_TAX_FILING',
    display_name: 'Tax Filing Intake',
    fields: [
      {
        path: 'tax_year',
        type: 'number',
        integer: true,
        min: 1900,
        max: 2100,
        required: true,
        description:
          'Four-digit tax year explicitly stated by the user. Do not infer the current year from relative phrases such as "this year".',
      },
      {
        path: 'filing_status',
        type: 'enum',
        required: true,
        enum: [
          'single',
          'married_filing_jointly',
          'married_filing_separately',
          'head_of_household',
          'qualifying_surviving_spouse',
        ],
        aliases: {
          single: ['single filer', 'unmarried', 'filing single'],
          married_filing_jointly: [
            'mfj',
            'joint return',
            'filing jointly',
            'filed jointly',
            'married filing joint',
            'jointly',
          ],
          married_filing_separately: [
            'mfs',
            'separate returns',
            'filing separately',
            'married filing separate',
          ],
          head_of_household: ['hoh', 'head of household filer'],
          qualifying_surviving_spouse: [
            'qss',
            'surviving spouse',
            'qualifying widow',
            'qualifying widower',
            'widow',
            'widower',
          ],
        },
        description:
          'Federal filing status. Use an allowed value only when the user states or clearly names that status. If two or more statuses are presented as undecided/ambiguous, return null.',
      },
      {
        path: 'return_type',
        type: 'enum',
        required: true,
        enum: ['individual', 'business'],
        aliases: {
          individual: ['personal return', 'personal taxes', '1040', 'individual return', 'personal'],
          business: ['company return', 'corporate return', 'business taxes', '1120', '1065'],
        },
        description:
          'Whether the return is for an individual or a business entity.',
      },
      {
        path: 'primary_income_source',
        type: 'enum',
        required: false,
        enum: ['employment', 'self_employment', 'investments', 'rental', 'retirement', 'other'],
        aliases: {
          employment: ['salary', 'wages', 'w-2', 'w2', 'payroll', 'employer'],
          self_employment: [
            'freelance',
            'freelancer',
            '1099',
            'contract work',
            'gig work',
            'business income',
            'self employed',
          ],
          investments: [
            'investment income',
            'dividends',
            'capital gains',
            'stocks',
            'interest income',
            'investment',
          ],
          rental: ['rental income', 'rent', 'property income'],
          retirement: ['retirement income', 'pension', 'social security', '401k', 'annuity'],
          other: ['other income', 'miscellaneous income'],
        },
        description:
          'The main source of income the user reports. Map only exact known synonyms; do not guess from occupation alone.',
      },
      {
        path: 'dependents_count',
        type: 'number',
        integer: true,
        min: 0,
        max: 30,
        required: false,
        description:
          'Number of dependents explicitly stated by the user. Do not infer from family descriptions.',
      },
      {
        path: 'needs_extension',
        type: 'boolean',
        required: false,
        description:
          'True if the user explicitly requests or states they need a filing extension. False if they explicitly state no extension is needed or filed. Null if unstated.',
      },
    ],
  },

  SCHEMA_ONBOARDING_FIELDS: {
    schema_reference_id: 'SCHEMA_ONBOARDING_FIELDS',
    form_id: 'FORM_EMPLOYEE_ONBOARDING',
    display_name: 'Employee Onboarding Intake',
    fields: [
      {
        path: 'employee_name',
        type: 'string',
        required: true,
        description: 'Full name of the new employee as stated by the user.',
      },
      {
        path: 'role_title',
        type: 'string',
        required: true,
        description:
          'Job title or role for the new employee. Do not invent a title from a department name.',
      },
      {
        path: 'employment_type',
        type: 'enum',
        required: true,
        enum: ['full_time', 'part_time', 'contractor', 'intern'],
        aliases: {
          full_time: ['full time', 'full-time', 'ft', 'permanent', 'permanent employee'],
          part_time: ['part time', 'part-time', 'pt'],
          contractor: ['contract', 'contractor', '1099', 'freelance', 'freelancer'],
          intern: ['internship', 'intern', 'trainee'],
        },
        description: 'Employment relationship for the new hire.',
      },
      {
        path: 'start_date',
        type: 'date',
        required: true,
        description:
          'Start date as an ISO date (YYYY-MM-DD). Return null if the date is ambiguous (for example a numeric format like 03/04/2026 without an explicit month/day convention).',
      },
      {
        path: 'work_arrangement',
        type: 'enum',
        required: false,
        enum: ['onsite', 'remote', 'hybrid'],
        aliases: {
          onsite: ['on-site', 'in office', 'in-office', 'office based', 'office-based'],
          remote: [
            'work from home',
            'wfh',
            'telework',
            'fully remote',
            'work remotely',
            'remotely',
          ],
          hybrid: ['hybrid', 'partially remote', 'mixed', 'part remote'],
        },
        description: 'Where the employee will work.',
      },
      {
        path: 'equipment_needed',
        type: 'boolean',
        required: false,
        description:
          'True if the user explicitly requests equipment (laptop, monitor, phone, etc.). False if they explicitly state no equipment is needed. Null if unstated.',
      },
      {
        path: 'department',
        type: 'string',
        required: false,
        description: 'Department or team the employee is joining, as stated by the user.',
      },
    ],
  },

  SCHEMA_CLAIM_FIELDS: {
    schema_reference_id: 'SCHEMA_CLAIM_FIELDS',
    form_id: 'FORM_INSURANCE_CLAIM',
    display_name: 'Insurance Claim Intake',
    fields: [
      {
        path: 'policy_number',
        type: 'string',
        required: true,
        description:
          'Policy number exactly as written by the user. Preserve punctuation and casing.',
      },
      {
        path: 'claim_type',
        type: 'enum',
        required: true,
        enum: ['auto', 'property', 'health', 'travel', 'liability'],
        aliases: {
          auto: ['car', 'vehicle', 'automobile', 'auto accident', 'auto insurance', 'auto claim'],
          property: ['home', 'house', 'homeowners', 'property damage', 'renters', 'home insurance'],
          health: ['medical', 'health insurance', 'hospital', 'medical claim', 'health claim'],
          travel: ['trip', 'travel insurance', 'baggage', 'flight', 'travel claim'],
          liability: ['third party', 'liability claim', 'personal liability'],
        },
        description:
          'Category of insurance claim. Marine, pet, and other unsupported categories must return null rather than being forced into a nearby value.',
      },
      {
        path: 'incident_date',
        type: 'date',
        required: true,
        description: 'Date the incident occurred, as an ISO date (YYYY-MM-DD). Null if unstated or ambiguous.',
      },
      {
        path: 'loss_description',
        type: 'string',
        required: true,
        description:
          'Brief factual description of what was lost or damaged, using the user\'s own wording. Do not add causes or details the user did not state.',
      },
      {
        path: 'estimated_loss_amount',
        type: 'number',
        required: false,
        min: 0,
        description:
          'Estimated loss amount in the currency the user stated. Numeric only; do not convert currencies or invent an amount.',
      },
      {
        path: 'police_report_filed',
        type: 'boolean',
        required: false,
        description:
          'True if the user states a police report was filed. False if they explicitly state one was not filed. Null if unstated.',
      },
    ],
  },

  SCHEMA_SUPPORT_FIELDS: {
    schema_reference_id: 'SCHEMA_SUPPORT_FIELDS',
    form_id: 'FORM_SUPPORT_TICKET',
    display_name: 'General Support Intake',
    fields: [
      {
        path: 'issue_category',
        type: 'enum',
        required: true,
        enum: ['account_access', 'billing', 'technical', 'feature_request', 'other'],
        aliases: {
          account_access: [
            'login',
            'log in',
            'log into',
            'sign in',
            'password',
            'account locked',
            'authentication',
            '2fa',
            'mfa',
          ],
          billing: ['payment', 'invoice', 'charge', 'charged', 'refund', 'subscription', 'billed'],
          technical: ['bug', 'error', 'crash', 'technical issue', 'outage', 'not working', 'broken'],
          feature_request: ['feature request', 'enhancement', 'suggestion', 'new feature', 'request a feature'],
          other: ['other', 'general question', 'misc'],
        },
        description: 'Primary category of the support request.',
      },
      {
        path: 'product_name',
        type: 'string',
        required: false,
        description: 'Product or service name stated by the user.',
      },
      {
        path: 'severity',
        type: 'enum',
        required: false,
        enum: ['low', 'medium', 'high', 'critical'],
        aliases: {
          low: ['low priority', 'minor', 'cosmetic'],
          medium: ['medium priority', 'moderate', 'normal'],
          high: ['high priority', 'major', 'urgent'],
          critical: ['blocker', 'sev1', 'sev 1', 'production down', 'emergency'],
        },
        description: 'Reported severity of the issue.',
      },
      {
        path: 'error_message',
        type: 'string',
        required: false,
        description:
          'Exact error message or on-screen text reported by the user. Do not paraphrase or invent an error code.',
      },
      {
        path: 'steps_to_reproduce',
        type: 'string',
        required: false,
        description:
          'Steps the user says reproduce the issue. Null unless the user actually lists steps.',
      },
      {
        path: 'affected_users_count',
        type: 'number',
        integer: true,
        min: 1,
        max: 1000000,
        required: false,
        description:
          'Number of users affected, only when explicitly stated. Do not infer from team size or vague words like "everyone".',
      },
    ],
  },
};

const schemasByFormId = Object.freeze(
  Object.values(formSchemas).reduce((acc, schema) => {
    acc[schema.form_id] = schema;
    return acc;
  }, {})
);

/**
 * @returns {Array<Object>} All field schemas.
 */
function getAllSchemas() {
  return Object.values(formSchemas);
}

/**
 * @param {string} formId
 * @returns {Object|undefined}
 */
function getSchemaByFormId(formId) {
  return schemasByFormId[formId];
}

/**
 * @param {string} schemaReferenceId
 * @returns {Object|undefined}
 */
function getSchemaById(schemaReferenceId) {
  return formSchemas[schemaReferenceId];
}

/**
 * @param {string} formId
 * @returns {string[]} Supported form ids that have a schema.
 */
function getSupportedFormIds() {
  return Object.keys(schemasByFormId);
}

/**
 * @param {string} formId
 * @returns {Array<Object>} Field definitions (empty when unknown).
 */
function getFields(formId) {
  const schema = getSchemaByFormId(formId);
  return schema ? schema.fields : [];
}

/**
 * Render a schema as a compact, model-readable text block.
 * No braces are used so the text is safe inside a ChatPromptTemplate.
 *
 * @param {Object} schema
 * @returns {string}
 */
function describeSchemaForPrompt(schema) {
  return schema.fields
    .map((field) => {
      const parts = [`- path: ${field.path}`, `type: ${field.type}`];

      if (field.type === 'enum') {
        parts.push(`allowed values: ${field.enum.join(' | ')}`);
        const aliasLines = Object.entries(field.aliases || {}).map(
          ([canonical, aliases]) =>
            `${canonical} <- ${aliases.length ? aliases.join(', ') : '(no aliases)'}`
        );
        if (aliasLines.length) {
          parts.push(`accepted synonyms: ${aliasLines.join('; ')}`);
        }
      }

      if (field.type === 'number') {
        if (field.integer) parts.push('integer: yes');
        if (Number.isFinite(field.min)) parts.push(`minimum: ${field.min}`);
        if (Number.isFinite(field.max)) parts.push(`maximum: ${field.max}`);
      }

      parts.push(`required: ${field.required ? 'yes' : 'no'}`);
      parts.push(`description: ${field.description}`);

      return parts.join(' | ');
    })
    .join('\n');
}

module.exports = {
  formSchemas,
  getAllSchemas,
  getSchemaByFormId,
  getSchemaById,
  getSupportedFormIds,
  getFields,
  describeSchemaForPrompt,
};
