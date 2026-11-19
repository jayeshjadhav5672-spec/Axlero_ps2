/**
 * extractionService.js
 *
 * Orchestrates schema-conditioned field extraction:
 *   1. Route the text to a form (unless the caller supplied form_id).
 *   2. Build/reuse a LangChain extraction chain for that form's schema.
 *   3. Normalize every value deterministically against the schema.
 *   4. Enforce provenance, null, and requires_review rules.
 *
 * The service never fabricates values. Unsupported evidence, invalid enum
 * values, and missing/incorrect provenance all resolve to null.
 */

const {
  getExtractionModel,
  getProviderSummary,
  resolveRetryConfig,
} = require('../utils/llmProvider');
const {
  getSchemaByFormId,
  getSupportedFormIds,
} = require('../data/formSchemas');
const {
  normalizeValue,
  isValueInSchema,
  resolveProvenance,
} = require('../utils/normalizer');
const { createExtractionChain } = require('../chains/extractionChain');
const {
  IntakeError,
  ValidationError,
  UnknownFormError,
  ExtractionProviderError,
} = require('../utils/errors');
const routingService = require('./routingService');

const DEFAULT_REVIEW_THRESHOLD = 0.75;
const DEFAULT_MAX_INPUT_CHARS = 20000;

function readThreshold(env = process.env) {
  const raw = env.INTAKE_REVIEW_CONFIDENCE_THRESHOLD;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_REVIEW_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      'INTAKE_REVIEW_CONFIDENCE_THRESHOLD must be a number between 0.0 and 1.0.'
    );
  }
  return parsed;
}

function readMaxInputChars(env = process.env) {
  const raw = env.INTAKE_MAX_INPUT_CHARS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_INPUT_CHARS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('INTAKE_MAX_INPUT_CHARS must be a positive integer.');
  }
  return parsed;
}

/**
 * Default chain factory. Creates the extraction model lazily so importing this
 * module never requires provider credentials.
 *
 * @param {Object} options
 * @returns {import('../chains/extractionChain').ExtractionChain}
 */
function defaultChainFactory({ schema }) {
  return createExtractionChain({
    schema,
    model: getExtractionModel(),
    retry: resolveRetryConfig('extraction'),
  });
}

function emptyField() {
  return {
    value: null,
    confidence: 0,
    provenance: null,
    requires_review: true,
  };
}

class ExtractionService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.routingService] - Injected router (defaults to routingService module).
   * @param {Function} [options.chainFactory] - ({schema}) => ExtractionChain.
   * @param {number} [options.reviewThreshold] - Confidence below this forces review.
   * @param {number} [options.maxInputChars]
   * @param {Function} [options.clock] - () => epoch ms (tests).
   */
  constructor(options = {}) {
    this.routingService = options.routingService || routingService;
    this.chainFactory = options.chainFactory || defaultChainFactory;
    this.reviewThreshold =
      options.reviewThreshold ?? readThreshold();
    this.maxInputChars = options.maxInputChars ?? readMaxInputChars();
    this.clock = options.clock || (() => Date.now());
    this.chains = new Map();
    // Report the model actually configured for extraction so responses and
    // health output never claim a hardcoded default. Falls back to the role
    // default only when the provider summary cannot resolve a model.
    this.extractionModelName =
      options.extractionModelName ||
      getProviderSummary('extraction').model ||
      'nvidia/nemotron-3-ultra-550b-a55b:free';
  }

  getChain(schema) {
    const key = schema.schema_reference_id;
    if (!this.chains.has(key)) {
      this.chains.set(key, this.chainFactory({ schema }));
    }
    return this.chains.get(key);
  }

  /**
   * @param {Object} params
   * @param {string} params.text
   * @param {string} [params.formId]
   * @returns {Promise<Object>} Extraction response contract.
   */
  async extract({ text, formId } = {}) {
    const startedAt = this.clock();

    if (typeof text !== 'string' || !text.trim()) {
      throw new ValidationError('text is required and must be a non-empty string.', {
        field: 'text',
      });
    }

    const sourceText = text.trim();
    if (sourceText.length > this.maxInputChars) {
      throw new ValidationError(
        `text exceeds the maximum length of ${this.maxInputChars} characters.`,
        { field: 'text', max_chars: this.maxInputChars }
      );
    }

    let routing;
    let routingSource;
    let selectedFormId;

    if (formId !== undefined && formId !== null && String(formId).trim() !== '') {
      selectedFormId = String(formId).trim();
      if (!getSchemaByFormId(selectedFormId)) {
        throw new UnknownFormError(selectedFormId, getSupportedFormIds());
      }
      routing = {
        form_id: selectedFormId,
        confidence: 1.0,
        rationale: 'Form explicitly supplied by the client; routing was skipped.',
        clarification_required: false,
      };
      routingSource = 'explicit';
    } else {
      try {
        routing = await this.routingService.route({ userPrompt: sourceText });
      } catch (err) {
        if (err instanceof IntakeError) throw err;
        throw new ExtractionProviderError(
          'Routing failed before extraction.',
          err
        );
      }
      routingSource = 'auto';

      if (
        !routing ||
        !routing.form_id ||
        routing.clarification_required ||
        !getSchemaByFormId(routing.form_id)
      ) {
        return this.buildClarificationResponse({
          routing,
          routingSource,
          startedAt,
        });
      }

      selectedFormId = routing.form_id;
    }

    const schema = getSchemaByFormId(selectedFormId);

    let raw;
    try {
      const chain = this.getChain(schema);
      raw = await chain.invoke({ text: sourceText });
    } catch (err) {
      if (err instanceof IntakeError) throw err;
      throw new ExtractionProviderError(
        `Field extraction failed for ${selectedFormId}.`,
        err
      );
    }

    const processed = this.processFields({
      schema,
      rawFields: raw.fields || {},
      sourceText,
    });

    return {
      form_id: schema.form_id,
      display_name: schema.display_name,
      schema_reference_id: schema.schema_reference_id,
      routing,
      routing_source: routingSource,
      clarification_required: false,
      fields: processed.fields,
      requires_review: processed.requiresReview,
      meta: {
        model: this.extractionModelName,
        duration_ms: Math.max(0, this.clock() - startedAt),
        field_count: schema.fields.length,
        extracted_count: processed.extractedCount,
        null_count: schema.fields.length - processed.extractedCount,
        alias_mapped_count: processed.aliasMappedCount,
        provenance_rejected_count: processed.provenanceRejectedCount,
        contract_warnings: raw.warnings || {},
      },
    };
  }

  /**
   * Apply deterministic normalization to every model-provided field.
   *
   * @param {Object} params
   * @param {Object} params.schema
   * @param {Object} params.rawFields
   * @param {string} params.sourceText
   * @returns {{fields: Object, requiresReview: boolean, extractedCount: number, aliasMappedCount: number, provenanceRejectedCount: number}}
   */
  processFields({ schema, rawFields, sourceText }) {
    const fields = {};
    let requiresReview = false;
    let extractedCount = 0;
    let aliasMappedCount = 0;
    let provenanceRejectedCount = 0;

    for (const field of schema.fields) {
      const entry = rawFields[field.path] || emptyField();

      const normalized = normalizeValue(field, entry.value);
      let value = normalized.value;
      let provenance = entry.provenance;
      let review = Boolean(entry.requires_review);
      const confidence = Math.min(1, Math.max(0, Number(entry.confidence) || 0));

      if (value !== null && !isValueInSchema(field, value)) {
        // Defence in depth: the normalizer should already guarantee this.
        value = null;
        provenance = null;
        review = true;
      }

      if (value === null) {
        // A null value can never carry provenance.
        provenance = null;
        review = true;
      } else {
        const resolved = resolveProvenance(provenance, sourceText);
        if (!resolved.ok) {
          // The model cited evidence that is not in the source. Discard the
          // value rather than returning unsupported data.
          value = null;
          provenance = null;
          review = true;
          provenanceRejectedCount += 1;
        } else {
          provenance = resolved.quote;
        }
      }

      if (normalized.aliasMapped) {
        review = true;
        aliasMappedCount += 1;
      }

      if (confidence < this.reviewThreshold) {
        review = true;
      }

      if (value !== null) extractedCount += 1;

      fields[field.path] = {
        value,
        confidence,
        provenance,
        requires_review: Boolean(review),
      };

      if (fields[field.path].requires_review) requiresReview = true;
    }

    return {
      fields,
      requiresReview,
      extractedCount,
      aliasMappedCount,
      provenanceRejectedCount,
    };
  }

  buildClarificationResponse({ routing, routingSource, startedAt }) {
    const safeRouting =
      routing && typeof routing === 'object'
        ? routing
        : {
            form_id: null,
            confidence: 0,
            rationale: 'Routing did not return a usable form decision.',
            clarification_required: true,
          };

    return {
      form_id: null,
      display_name: null,
      schema_reference_id: null,
      routing: safeRouting,
      routing_source: routingSource,
      clarification_required: true,
      fields: {},
      requires_review: true,
      meta: {
        model: this.extractionModelName,
        duration_ms: Math.max(0, this.clock() - startedAt),
        field_count: 0,
        extracted_count: 0,
        null_count: 0,
        alias_mapped_count: 0,
        provenance_rejected_count: 0,
        contract_warnings: {},
      },
    };
  }
}

/**
 * Default singleton, lazily constructed so module import never requires
 * provider credentials.
 */
let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = new ExtractionService();
  return defaultService;
}

module.exports = {
  ExtractionService,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_MAX_INPUT_CHARS,
  createExtractionService: (options) => new ExtractionService(options),
  extract: (params) => getDefaultService().extract(params),
  getDefaultService,
};
