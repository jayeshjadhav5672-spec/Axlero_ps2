/**
 * errors.js
 *
 * Typed errors for the AI Intake Pipeline. Controllers translate these into
 * HTTP responses without ever guessing or fabricating extracted data.
 */

class IntakeError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {number} [options.status]   Suggested HTTP status code.
   * @param {string} [options.code]     Stable machine-readable error code.
   * @param {Object} [options.details]  Additional safe, non-secret details.
   * @param {Error}  [options.cause]    Original error, kept for server logs.
   */
  constructor(message, { status = 500, code = 'intake_error', details, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

class ValidationError extends IntakeError {
  constructor(message, details) {
    super(message, { status: 400, code: 'validation_error', details });
  }
}

class UnknownFormError extends ValidationError {
  constructor(formId, supportedFormIds = []) {
    super(`Unknown form_id "${formId}".`, {
      form_id: formId,
      supported_form_ids: supportedFormIds,
    });
    this.code = 'unknown_form_id';
  }
}

class ExtractionProviderError extends IntakeError {
  constructor(message, cause) {
    const originalCause =
      cause ||
      (message instanceof Error ? message : new Error(String(message ?? 'unknown provider error')));

    // The public message is deliberately generic. Provider errors can contain
    // request details, account identifiers, or partially masked credentials.
    // Keep the original on `cause` for server-side logs only.
    super(
      'Field extraction failed because the provider was unavailable or misconfigured.',
      {
        status: 502,
        code: 'extraction_provider_error',
        details: {
          message:
            'The extraction provider failed. No values were fabricated; retry the request or require clarification.',
        },
        cause: originalCause,
      }
    );
  }
}

module.exports = {
  IntakeError,
  ValidationError,
  UnknownFormError,
  ExtractionProviderError,
};
