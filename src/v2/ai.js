'use strict';

// AI assistant: Claude (Anthropic) or ChatGPT (OpenAI), behind one endpoint.
// Keys stay on the server. Context is limited to what the requesting person
// can already see, sensitive values are redacted before sending, and nothing is
// ever posted or created automatically: suggestions come back for a human click.
//
// Env: ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_DEFAULT_PROVIDER (claude|openai),
//      AI_CLAUDE_MODEL, AI_OPENAI_MODEL, AI_DAILY_LIMIT (requests/person/day, default 100).

const { db } = require('../db');

const PROVIDERS = {
  claude: {
    key: () => process.env.ANTHROPIC_API_KEY,
    model: () => process.env.AI_CLAUDE_MODEL || 'claude-sonnet-4-5',
    label: 'Claude',
  },
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    model: () => process.env.AI_OPENAI_MODEL || 'gpt-4o-mini',
    label: 'ChatGPT',
  },
};

function available() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.key())
    .map(([id, p]) => ({ id, label: p.label, model: p.model() }));
}

function defaultProvider() {
  const want = String(process.env.AI_DEFAULT_PROVIDER || 'claude').toLowerCase();
  const list = available();
  return (list.find((p) => p.id === want) || list[0] || {}).id || null;
}

// Remove things that must never leave the portal.
function redact(text) {
  return String(text || '')
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[redacted-id]') // Aadhaar-like
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[redacted-pan]') // PAN
    .replace(/\b\d{9,18}\b/g, '[redacted-number]') // account numbers
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, '[redacted-ifsc]') // IFSC
    .replace(/(salary|ctc|gross pay|net pay)\s*[:=]?\s*(₹|rs\.?|inr|\$)?\s*[\d,]+(\.\d+)?/gi, '$1 [redacted]');
}

const SYSTEM = `You are the assistant inside the LIT Nexus employee portal (an accounting and bookkeeping firm).
Be concise and professional, in US English. Never invent facts that are not in the provided context.
When asked for suggestions, return JSON only, in this shape:
{"text": "<short answer or summary>", "suggestions": [{"type": "create_task", "name": "...", "due_on": "yyyy-mm-dd or null"} | {"type": "reply", "text": "..."}]}`;

const ACTIONS = {
  summarize_thread: (ctx) =>
    `Summarize this conversation in 3-5 sentences, then list open action items as create_task suggestions.\n\n${ctx}`,
  draft_reply: (ctx, prompt) =>
    `Draft a short, professional reply to the latest message. ${prompt ? 'Guidance: ' + prompt : ''} Return it as a single "reply" suggestion.\n\n${ctx}`,
  suggest_tasks: (ctx) =>
    `List the concrete follow-up tasks from this conversation as create_task suggestions.\n\n${ctx}`,
  draft_invoice_notes: (ctx) =>
    `Write a 1-2 sentence, friendly invoice note for the client based on these line items. Put it in "text".\n\n${ctx}`,
  ask: (ctx, prompt) => `${prompt}\n\n${ctx ? 'Context:\n' + ctx : ''}`,
};

const usedToday = db.prepare('SELECT COUNT(*) AS n FROM int_ai_usage WHERE user_id=? AND ts > ?');
const logUsage = db.prepare(
  'INSERT INTO int_ai_usage(user_id, provider, action, input_tokens, output_tokens, ts) VALUES (?,?,?,?,?,?)',
);

async function callClaude(system, user) {
  const res = await fetch(process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': PROVIDERS.claude.key(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PROVIDERS.claude.model(),
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error('Claude: ' + (body.error?.message || `HTTP ${res.status}`)), { status: 502 });
  return {
    text: (body.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
    usage: { input: body.usage?.input_tokens || 0, output: body.usage?.output_tokens || 0 },
  };
}

async function callOpenAI(system, user) {
  const res = await fetch(process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROVIDERS.openai.key()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: PROVIDERS.openai.model(),
      max_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error('ChatGPT: ' + (body.error?.message || `HTTP ${res.status}`)), { status: 502 });
  return {
    text: body.choices?.[0]?.message?.content || '',
    usage: { input: body.usage?.prompt_tokens || 0, output: body.usage?.completion_tokens || 0 },
  };
}

function parseReply(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const suggestions = Array.isArray(j.suggestions)
        ? j.suggestions
            .filter((s) => s && ['create_task', 'reply'].includes(s.type))
            .slice(0, 10)
            .map((s) =>
              s.type === 'create_task'
                ? {
                    type: 'create_task',
                    name: String(s.name || '').slice(0, 300),
                    due_on: /^\d{4}-\d{2}-\d{2}$/.test(s.due_on || '') ? s.due_on : null,
                  }
                : { type: 'reply', text: String(s.text || '').slice(0, 4000) },
            )
        : [];
      return { text: String(j.text || '').slice(0, 8000), suggestions };
    } catch (_e) {
      /* plain text */
    }
  }
  return { text: String(raw).slice(0, 8000), suggestions: [] };
}

async function complete({ user, provider, action, context, prompt }) {
  const chosen = provider || defaultProvider();
  if (!chosen || !PROVIDERS[chosen] || !PROVIDERS[chosen].key())
    throw Object.assign(
      new Error('No AI provider is configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Railway.'),
      { status: 503 },
    );
  if (!ACTIONS[action]) throw Object.assign(new Error('Unknown AI action'), { status: 400 });
  if (action === 'ask' && !String(prompt || '').trim())
    throw Object.assign(new Error('Ask a question first'), { status: 400 });
  const limit = Number(process.env.AI_DAILY_LIMIT || 100);
  if (usedToday.get(user.id, Date.now() - 86400000).n >= limit)
    throw Object.assign(new Error('Daily AI limit reached. Try again tomorrow.'), { status: 429 });
  const userMsg = ACTIONS[action](redact(context).slice(0, 60000), redact(prompt || '').slice(0, 4000));
  const out = chosen === 'claude' ? await callClaude(SYSTEM, userMsg) : await callOpenAI(SYSTEM, userMsg);
  logUsage.run(user.id, chosen, action, out.usage.input, out.usage.output, Date.now());
  return { provider: chosen, ...parseReply(out.text), usage: out.usage };
}

module.exports = { complete, available, defaultProvider, redact, parseReply };
