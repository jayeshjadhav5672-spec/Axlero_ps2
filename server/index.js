/**
 * index.js - AI Intake Pipeline backend entry point (Node.js / Express).
 *
 * Sets up Express, mounts the intake module routes, and starts the server.
 * All provider credentials are loaded from .env via dotenv and never hardcoded.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const intakeRoutes = require('./modules/intake/routes/intake.routes');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check (global)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ai-intake-backend', timestamp: new Date().toISOString() });
});

// Intake module routes (mounted at /api/intake)
app.use('/api/intake', intakeRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server (also exported for testing)
const server = app.listen(PORT, () => {
  console.log(`AI Intake Backend listening on http://localhost:${PORT}`);
  console.log(`Intake health: http://localhost:${PORT}/api/intake/health`);
});

module.exports = { app, server };
