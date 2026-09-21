'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FIELDS = 'name,created_at,modified_at,completed,completed_at,completed_by.name,assignee.name,assignee.email,due_on,due_at,notes,custom_fields.name,custom_fields.display_value,num_subtasks';

function createApi(config, fetchImpl = fetch, wait = sleep) {
  async function request(url, options = {}, posting = false) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try { res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) }); }
      catch (_) {
        if (posting) throw Object.assign(new Error('Slack delivery outcome unknown; inspect channel before retrying'), { ambiguous: true });
        if (attempt === 3) throw new Error('Remote API connection failed');
        await wait(1000 * 2 ** attempt); continue;
      }
      if (res.status === 429) {
        const retry = Math.max(1, Number(res.headers.get('retry-after')) || 10);
        if (attempt === 3 || retry > 120) throw new Error('Remote API rate limited; will retry later');
        await wait(retry * 1000); continue;
      }
      if (res.status >= 500) {
        if (posting) throw Object.assign(new Error('Slack delivery outcome unknown; inspect channel before retrying'), { ambiguous: true });
        if (attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
      }
      let body;
      try { body = await res.json(); }
      catch (_) { throw Object.assign(new Error('Remote API returned invalid JSON'), { ambiguous: posting }); }
      if (!res.ok || body.ok === false) {
        // Do not log upstream descriptions which can include personal data or tokens.
        throw new Error(`Remote API rejected request (${res.status}${body.error ? ', ' + String(body.error).replace(/[^a-z_]/gi, '').slice(0, 60) : ''})`);
      }
      return body;
    }
  }
  const asana = path => request('https://app.asana.com/api/1.0' + path, { headers: { Authorization: `Bearer ${config.asanaToken}` } });
  const slack = (method, args = {}, posting = false) => {
    const url = 'https://slack.com/api/' + method;
    const headers = { Authorization: `Bearer ${config.slackToken}` };
    // Read methods use query parameters; Slack can ignore their JSON POST body.
    if (!posting) return request(url + '?' + new URLSearchParams(args), { method: 'GET', headers });
    return request(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(args),
    }, true);
  };

  async function pages(path, params) {
    const out = []; const seen = new Set();
    let offset;
    do {
      const query = new URLSearchParams({ ...params, limit: '100', ...(offset ? { offset } : {}) });
      const body = await asana(`${path}?${query}`);
      if (!Array.isArray(body.data)) throw new Error('Asana returned an invalid task list');
      out.push(...body.data);
      offset = body.next_page?.offset;
      if (offset && seen.has(offset)) throw new Error('Asana pagination repeated; snapshot not saved');
      seen.add(offset);
      if (seen.size > 500) throw new Error('Asana pagination limit exceeded; snapshot not saved');
    } while (offset);
    return out;
  }

  async function collect(window) {
    const tasks = new Map(); const projects = [];
    for (const project of config.projects) {
      const meta = await asana(`/projects/${encodeURIComponent(project)}?opt_fields=name`);
      const name = meta.data?.name || project;
      projects.push(name);
      // Include old completed parents too: they can contain still-open subtasks.
      const rows = await pages('/tasks', { project, opt_fields: FIELDS });
      for (const t of rows) {
        const existing = tasks.get(t.gid);
        if (existing) existing.projectNames.push(name);
        else tasks.set(t.gid, { ...t, projectNames: [name] });
      }
    }
    // Project endpoints omit subtasks that are not themselves project members.
    const queue = [...tasks.values()]; const expanded = new Set();
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      if (!parent.num_subtasks || expanded.has(parent.gid)) continue;
      expanded.add(parent.gid);
      if (expanded.size > 5000) throw new Error('Subtask traversal limit exceeded; snapshot not saved');
      for (const t of await pages(`/tasks/${encodeURIComponent(parent.gid)}/subtasks`, { opt_fields: FIELDS })) {
        if (!tasks.has(t.gid)) {
          const item = { ...t, projectNames: parent.projectNames };
          tasks.set(t.gid, item); queue.push(item);
        }
      }
    }
    return { tasks: [...tasks.values()], projects };
  }

  async function resolveUsers(tasks) {
    const map = { ...config.userMap }; const warnings = [];
    const missing = tasks.filter(t => t.assignee && !map[t.assignee.gid]);
    if (!missing.length) return { map, warnings };
    const users = []; const cursors = new Set(); let cursor;
    try {
      do {
        const body = await slack('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
        users.push(...(body.members || []));
        cursor = body.response_metadata?.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error('Slack pagination repeated');
        cursors.add(cursor);
      } while (cursor);
      for (const t of missing) {
        const email = String(t.assignee.email || '').trim().toLowerCase();
        const matches = users.filter(u => !u.deleted && !u.is_bot && email && String(u.profile?.email || '').toLowerCase() === email);
        if (matches.length === 1) map[t.assignee.gid] = matches[0].id;
      }
    } catch (_) { warnings.push('Slack email lookup unavailable; only confirmed user mappings are tagged.'); }
    return { map, warnings };
  }

  async function check() {
    await slack('auth.test');
    const info = await slack('conversations.info', { channel: config.channel });
    if (!info.channel?.is_member) throw new Error('Slack bot must be invited to the EOD channel');
    if (info.channel?.is_archived) throw new Error('Slack EOD channel is archived');
    for (const gid of config.projects) await asana(`/projects/${encodeURIComponent(gid)}?opt_fields=name`);
    return { ok: true, channel: info.channel.name };
  }

  const post = (text, threadTs) => slack('chat.postMessage', { channel: config.channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), parse: 'none', unfurl_links: false, unfurl_media: false }, true);
  return { collect, resolveUsers, post, check, wait };
}

module.exports = { createApi };
