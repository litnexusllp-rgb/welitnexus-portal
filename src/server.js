'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { db } = require('./db');
const { loadUser } = require('./auth');
const { bootstrapAdmin } = require('./bootstrap');
const { startBackgroundWorker } = require('./backgroundWorker');


const app = express();
app.set('trust proxy', require('./proxyConfig').trustProxy());

// Security headers. CSP is tuned for this app: inline styles + Google Fonts
// are used by the frontend, scripts are loaded from same-origin files only.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(loadUser);

// Generous throttle on mutating API calls (reads are unrestricted). Blunts
// abuse/runaway scripts without getting in the way of normal use. Login has
// its own stricter limiter in routes/auth.js.
// Keyed PER SIGNED-IN USER (not per IP), so a whole team sharing one mobile-
// carrier IP (CGNAT) each gets their own budget; anonymous traffic falls back
// to per-IP.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : require('./rateLimitKey').ipKey(req)),
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});
app.use('/api', writeLimiter);
app.use('/api', require('./requestValidation').validateRequest);

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/holidays', require('./routes/holidays'));
app.use('/api/bonuses', require('./routes/bonuses'));
app.use('/api/users', require('./routes/directory'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/recurring', require('./routes/recurring'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/kpi', require('./routes/kpi'));
app.use('/api/salaries', require('./routes/salaries'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/workingdays', require('./routes/workingdays'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/punch-requests', require('./routes/punchRequests'));
app.use('/api/asana', require('./routes/asana'));
app.use('/api/asana-review', require('./routes/asanaReview'));
app.use('/api/operations', require('./routes/operations'));
app.use('/api/eod', require('./routes/eod'));

// Health check for uptime monitors: confirms the server AND the database
// respond. Returns 503 if the DB is unreachable so monitors flag it as down.
let backgroundHealth = () => true;
app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    if (!backgroundHealth()) return res.status(503).json({ ok: false, error: 'background worker unavailable', ts: Date.now() });
    res.json({ ok: true, ts: Date.now(), revision: process.env.RAILWAY_GIT_COMMIT_SHA || null });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unavailable', ts: Date.now() });
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback — send the app shell for any non-API GET.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler — keep API responses JSON and never leak stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (res.headersSent) return _next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  if (status >= 500) console.error('Unhandled error:', err);
  res.status(status).json({ error: status < 500 ? (err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message) : 'Something went wrong. Please try again.' });
});

async function start() {
  await bootstrapAdmin();
  const stopBackground = startBackgroundWorker();
  backgroundHealth = stopBackground.health || (() => true);
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => console.log(`WeLitNexus portal running on http://localhost:${server.address().port}`));
  require('./shutdown').installShutdown({ server, db, stopBackground });
  server.on('error', async error => { console.error('HTTP startup failed:', error); await stopBackground(); db.close(); process.exitCode = 1; });
  return server;
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error); if (db.open) db.close(); process.exitCode = 1; });
module.exports = { app, start };
