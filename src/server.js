'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { loadUser } = require('./auth');
const { bootstrapAdmin } = require('./bootstrap');
const { startRecurringScheduler } = require('./recurring');

bootstrapAdmin(); // create first admin on a fresh database

const app = express();
app.use(express.json());
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WeLitNexus portal running on http://localhost:${PORT}`);
  startRecurringScheduler(); // generate recurring tasks on boot + every 6h
});
