'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { loadUser } = require('./auth');
const { bootstrapAdmin } = require('./bootstrap');
const { startRecurringScheduler } = require('./recurring');

bootstrapAdmin(); // create first admin on a fresh database

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS in front of us; needed for rate-limit + secure cookies

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

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/holidays', require('./routes/holidays'));
app.use('/api/users', require('./routes/directory'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/recurring', require('./routes/recurring'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/kpi', require('./routes/kpi'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WeLitNexus portal running on http://localhost:${PORT}`);
  startRecurringScheduler(); // generate recurring tasks on boot + every 6h
});
