/**
 * Shared test doubles. Not a test file itself.
 */

const { RunnableLambda } = require('@langchain/core/runnables');

/**
 * Minimal chat-model double that supports both direct invoke and LangChain's
 * structured-output path. `payload` may be an object or a function.
 */
function createStructuredModel(payload) {
  const resolvePayload =
    typeof payload === 'function' ? payload : () => payload;

  return {
    invoke: async () => resolvePayload(),
    withStructuredOutput: () => RunnableLambda.from(async () => resolvePayload()),
  };
}

function field(value, confidence = 0.9, provenance = null, requiresReview = false) {
  return {
    value,
    confidence,
    provenance,
    requires_review: requiresReview,
  };
}

function chainReturning(fields, warnings = {}) {
  return {
    invoke: async () => ({ fields, warnings }),
  };
}

module.exports = {
  createStructuredModel,
  field,
  chainReturning,
};
