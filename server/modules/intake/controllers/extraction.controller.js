/**
 * extraction.controller.js
 *
 * HTTP controller for schema-conditioned field extraction.
 */

const extractionService = require('../services/extractionService');
const { IntakeError } = require('../utils/errors');

function resolveService(req, key, fallback) {
  return (
    (req.app && req.app.locals && req.app.locals.intakeServices &&
      req.app.locals.intakeServices[key]) ||
    fallback
  );
}

/**
 * POST /api/intake/extract
 * Body: { text: string, form_id?: string }
 *
 * `text` may also be supplied as `intake_text` for client convenience.
 * When `form_id` is omitted the prompt is routed first; ambiguous prompts
 * return clarification_required: true with no extracted fields.
 */
exports.extract = async (req, res) => {
  const body = req.body || {};
  const text = body.text ?? body.intake_text;
  const formId = body.form_id;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'text is required and must be a non-empty string.',
      details: { field: 'text' },
    });
  }

  if (
    formId !== undefined &&
    formId !== null &&
    (typeof formId !== 'string' || !formId.trim())
  ) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'form_id must be a non-empty string when provided.',
      details: { field: 'form_id' },
    });
  }

  const service = resolveService(req, 'extractionService', extractionService);

  try {
    const result = await service.extract({
      text: text.trim(),
      formId: formId ? formId.trim() : undefined,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof IntakeError) {
      return res.status(err.status || 500).json({
        error: err.code || 'intake_error',
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }

    // Unexpected failure: never return fabricated fields.
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to extract fields from the intake text.',
    });
  }
};
