/**
 * index.js - AI Intake Pipeline backend entry point (Node.js / Express).
 *
 * Sets up Express, mounts the intake module routes, and starts the server.
 * All provider credentials are loaded from .env via dotenv and never hardcoded.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const intakeRoutes = require('./modules/intake/routes/intakeRoutes');

/**
 * Build the Express app without starting a listener. Exported for tests and
 * for embedding in a larger service.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ai-intake-backend',
      timestamp: new Date().toISOString(),
    });
  });

  // Intake module routes (mounted at /api/intake)
  app.use('/api/intake', intakeRoutes);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Malformed JSON and other middleware errors.
  app.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Request body is not valid JSON.',
      });
    }
    return res.status(500).json({
      error: 'internal_error',
      message: 'Unexpected server error.',
    });
  });

  return app;
}

const app = createApp();
let server = null;

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  server = app.listen(PORT, () => {
    console.log(`AI Intake Backend listening on http://localhost:${PORT}`);
    console.log(`Intake health: http://localhost:${PORT}/api/intake/health`);
  });
}

module.exports = { app, server, createApp };
