/**
 * routingService.js
 *
 * Form routing service for the AI Intake Pipeline.
 *
 * Classifies a free-text user prompt against the form catalogue using a fast
 * routing model (gpt-4o-mini) and returns a strictly structured routing
 * decision (FormRouteResponse) validated with Zod.
 *
 * Ambiguous, vague, or out-of-catalogue prompts default to
 * clarification_required: true instead of guessing.
 */

const { z } = require('zod');
const { getRoutingModel } = require('../utils/llmProvider');
const { formCatalogue, catalogueText } = require('../data/formCatalogue');

// ---------------------------------------------------------------------------
// Structured output contract: FormRouteResponse
// ---------------------------------------------------------------------------

const FormRouteResponseSchema = z.object({
  form_id: z
    .string()
    .nullable()
    .describe(
      'The matched form_id from the catalogue, or null if no form could be confidently resolved.'
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score between 0.0 and 1.0 for the routing decision.'),
  rationale: z
    .string()
    .describe(
      'Concise summary of why this form was (or was not) chosen based on the user text.'
    ),
  clarification_required: z
    .boolean()
    .describe(
      'True when the prompt is too ambiguous, vague, or outside the catalogue to route confidently.'
    ),
});

/**
 * Safe default routing response used when the input cannot be resolved or the
 * model fails. Never guesses a form.
 * @type {z.infer<typeof FormRouteResponseSchema>}
 */
const UNRESOLVED_ROUTE = {
  form_id: null,
  confidence: 0.0,
  rationale:
    'The prompt was too ambiguous, vague, or outside the supported form catalogue to route confidently. Clarification is required.',
  clarification_required: true,
};

// Confidence floor below which we override the model and force clarification.
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Build the system prompt that instructs the routing model.
 * @returns {string}
 */
function buildSystemPrompt() {
  return `You are an intake specialist for an AI intake pipeline. Your job is to read a free-text user prompt and classify it against a fixed catalogue of supported intake forms.

Supported forms (form_id: display_name — description [schema_reference_id]):
${catalogueText()}

Instructions:
1. Evaluate the user's prompt against every form in the catalogue above.
2. Choose the single best-matching form ONLY if the prompt clearly maps to that form's purpose.
3. If the prompt is ambiguous, vague, incomplete, or does not match any catalogue form, do NOT guess. Set form_id to null, confidence to 0.0, clarification_required to true, and explain why in the rationale.
4. When a match is confident, set clarification_required to false, confidence to a value between 0.0 and 1.0, and explain the match in the rationale.
5. Output strictly the structured FormRouteResponse fields and nothing else. No markdown, no preamble, no extra keys.`;
}

/**
 * RoutingService wraps the fast routing model with structured output.
 */
class RoutingService {
  /**
   * @param {Object} options
   * @param {import('@langchain/openai').ChatOpenAI} [options.model]
   *   Injected routing model (defaults to getRoutingModel()). Useful for tests.
   */
  constructor(options = {}) {
    this.model = options.model || getRoutingModel();
    this.structuredModel = this.model.withStructuredOutput(FormRouteResponseSchema);
  }

  /**
   * Route a user prompt to the best matching form.
   * @param {Object} params
   * @param {string} params.userPrompt - Free-text user input.
   * @returns {Promise<Object>} Parsed FormRouteResponse object.
   */
  async route({ userPrompt }) {
    if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
      return {
        ...UNRESOLVED_ROUTE,
        rationale: 'Empty or missing user prompt; nothing to route.',
      };
    }

    const trimmed = userPrompt.trim();

    try {
      const result = await this.structuredModel.invoke([
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: `User prompt: "${trimmed}"` },
      ]);

      // LangChain withStructuredOutput returns a parsed object conforming to
      // the Zod schema. Re-validate defensively and never guess on violation.
      const parsed = FormRouteResponseSchema.safeParse(result);

      if (!parsed.success) {
        return {
          ...UNRESOLVED_ROUTE,
          rationale: `Model output did not conform to the routing contract (${parsed.error.issues
            .map((issue) => issue.path.join('.'))
            .join(', ')}). Treated as unresolved.`,
        };
      }

      const routed = parsed.data;

      // Safety net: missing form_id or low confidence forces clarification.
      if (!routed.form_id || routed.confidence < LOW_CONFIDENCE_THRESHOLD) {
        return {
          form_id: null,
          confidence: routed.confidence ?? 0.0,
          rationale:
            routed.rationale ||
            'Confidence below routing threshold; classification too uncertain.',
          clarification_required: true,
        };
      }

      return routed;
    } catch (err) {
      // Provider failure: never guess; require clarification.
      return {
        ...UNRESOLVED_ROUTE,
        rationale: `Routing service error: ${err.message}. Treated as unresolved pending clarification.`,
      };
    }
  }
}

/**
 * Default singleton instance used by the HTTP controller.
 * Lazily initialized on first use so requiring this module never throws
 * (e.g. when OPENAI_API_KEY is not yet configured).
 */
let defaultRoutingService = null;
function getDefaultService() {
  if (!defaultRoutingService) {
    defaultRoutingService = new RoutingService();
  }
  return defaultRoutingService;
}

module.exports = {
  RoutingService,
  FormRouteResponseSchema,
  UNRESOLVED_ROUTE,
  buildSystemPrompt,
  createRoutingService: (options) => new RoutingService(options),
  route: (...args) => getDefaultService().route(...args),
};
