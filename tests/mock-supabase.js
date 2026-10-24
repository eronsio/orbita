// A tiny stand-in for the parts of Supabase that Orbita uses (GoTrue auth + the orbita_data table), for testing
// sign-in and sync locally without a real project.   Run:  node tests/mock-supabase.js   (listens on :54321)
// Then open the app on localhost with  ?supabase=http://localhost:54321&key=test
// The two hostnames localhost and 127.0.0.1 are different browser origins, so they act as two separate "devices".
//
// It enforces the same rules the real SQL does: a user can only touch their own row, and PATCH honours the
// version filter. Test hooks (not part of Supabase):
//   POST /__reset            forget everything
//   POST /__fail?on=1|0      answer every request with 503 (simulates being offline)
//   GET  /__last_recovery    the link a "password reset email" would contain
//   POST /__ttl?seconds=N    token lifetime for new sessions (use a small N to test refresh)
const http = require('http');
const crypto = require('crypto');

let users, sessions, rows, lastRecovery, failing, ttl, tg, lastTs;
const reset = () => {
  users = new Map(); sessions = new Map(); rows = new Map(); lastRecovery = null; failing = false; ttl = 3600; lastTs = 0;
  tg = { names: new Map(), circles: new Map(), members: [], invites: [], messages: [], entries: [], shares: [] };
};
reset();
const CONFIRM = process.env.MOCK_CONFIRM === '1';
const uuid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(24).toString('hex');

function issue(user) {
  const access = `a_${token()}`; const refresh = `r_${token()}`;
  sessions.set(access, { user, exp: Date.now() + ttl * 1000 });
  sessions.set(refresh, { user, refresh: true });
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: ttl, user: { id: user.id, email: user.email } };
}

const send = (res, status, body, extra = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', ...extra,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

function authed(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = sessions.get(t);
  return s && !s.refresh && s.exp > Date.now() ? s.user : null;
}

const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
});

const feedback = [];

// ---------------- Together (chat + journals): a simplified in-memory copy of supabase/orbita_together.sql ----------------
// The real rules are tested against a real Postgres in tests/together.sql.test.js; this only exists so the app's screens
// can be driven locally. Same function names, same JSON shapes.
const nowIso = () => { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); };
const emailOf = (uid) => { for (const u of users.values()) if (u.id === uid) return u.email; return null; };
const nameOf = (uid) => tg.names.get(uid) || (emailOf(uid) || 'someone').split('@')[0];
const cleanEmails = (list, me) => [...new Set((list || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== me))];
const isMember = (cid, uid) => tg.members.some((m) => m.circle_id === cid && m.user_id === uid);
class Fail extends Error {}
const bad = (m) => { throw new Fail(m); };

const TG = {
  orbita_me: (u) => ({ user_id: u.id, email: u.email, name: nameOf(u.id) }),
  orbita_set_display_name: (u, a) => { const n = String(a.p_name || '').trim(); if (n.length < 1 || n.length > 60) bad('Please use 1 to 60 characters for your name.'); tg.names.set(u.id, n); return null; },
  orbita_create_circle: (u, a) => {
    const kind = a.p_kind || 'group'; const emails = cleanEmails(a.p_emails, u.email); let name = String(a.p_name || '').trim();
    if (!['group', 'direct'].includes(kind)) bad('bad kind');
    if (kind === 'direct') {
      if (emails.length !== 1) bad('A one-to-one chat needs exactly one other email address.');
      const hit = [...tg.circles.values()].find((c) => c.kind === 'direct' && isMember(c.id, u.id) && (tg.invites.some((i) => i.circle_id === c.id && i.email === emails[0]) || tg.members.some((m) => m.circle_id === c.id && m.user_id !== u.id && emailOf(m.user_id) === emails[0])));
      if (hit) return hit.id;
      name = '';
    } else if (name.length < 1 || name.length > 60) bad('Give the group a name (up to 60 characters).');
    const c = { id: uuid(), name, kind, created_at: nowIso() };
    tg.circles.set(c.id, c); tg.members.push({ circle_id: c.id, user_id: u.id, role: 'owner', joined_at: nowIso(), last_read_at: nowIso() });
    emails.forEach((e) => tg.invites.push({ id: uuid(), circle_id: c.id, email: e, invited_by: u.id, created_at: nowIso() }));
    return c.id;
  },
  orbita_invite: (u, a) => {
    const c = tg.circles.get(a.p_circle); if (!c || !isMember(c.id, u.id)) bad('You are not in that group.');
    if (c.kind === 'direct') bad('A one-to-one chat can only have two people. Start a group instead.');
    let n = 0;
    cleanEmails(a.p_emails, u.email).forEach((e) => {
      if (tg.invites.some((i) => i.circle_id === c.id && i.email === e) || tg.members.some((m) => m.circle_id === c.id && emailOf(m.user_id) === e)) return;
      tg.invites.push({ id: uuid(), circle_id: c.id, email: e, invited_by: u.id, created_at: nowIso() }); n++;
    });
    return n;
  },
  orbita_my_invites: (u) => tg.invites.filter((i) => i.email === u.email).map((i) => { const c = tg.circles.get(i.circle_id); return { id: i.id, circle_id: c.id, name: c.name, kind: c.kind, from: nameOf(i.invited_by), created_at: i.created_at }; }).reverse(),
  orbita_accept_invite: (u, a) => {
    const i = tg.invites.find((x) => x.id === a.p_invite && x.email === u.email); if (!i) bad('That invitation is no longer available.');
    const c = tg.circles.get(i.circle_id);
    if (c.kind === 'direct' && tg.members.filter((m) => m.circle_id === c.id).length >= 2) { tg.invites = tg.invites.filter((x) => x !== i); bad('That chat already has two people.'); }
    if (!isMember(c.id, u.id)) tg.members.push({ circle_id: c.id, user_id: u.id, role: 'member', joined_at: nowIso(), last_read_at: nowIso() });
    tg.invites = tg.invites.filter((x) => x !== i);
    return c.id;
  },
  orbita_decline_invite: (u, a) => { tg.invites = tg.invites.filter((i) => !(i.id === a.p_invite && i.email === u.email)); return null; },
  orbita_cancel_invite: (u, a) => { tg.invites = tg.invites.filter((i) => !(i.id === a.p_invite && isMember(i.circle_id, u.id))); return null; },
  orbita_leave_circle: (u, a) => {
    tg.members = tg.members.filter((m) => !(m.circle_id === a.p_circle && m.user_id === u.id));
    const left = tg.members.filter((m) => m.circle_id === a.p_circle);
    if (!left.length) { tg.circles.delete(a.p_circle); tg.invites = tg.invites.filter((i) => i.circle_id !== a.p_circle); tg.messages = tg.messages.filter((m) => m.circle_id !== a.p_circle); tg.shares = tg.shares.filter((s) => s.circle_id !== a.p_circle); }
    else if (!left.some((m) => m.role === 'owner')) left[0].role = 'owner';
    return null;
  },
  orbita_rename_circle: (u, a) => {
    const m = tg.members.find((x) => x.circle_id === a.p_circle && x.user_id === u.id);
    if (!m || m.role !== 'owner') bad('Only the person who runs the group can rename it.');
    const n = String(a.p_name || '').trim(); if (n.length < 1 || n.length > 60) bad('Give the group a name (up to 60 characters).');
    tg.circles.get(a.p_circle).name = n; return null;
  },
  orbita_my_circles: (u) => {
    const out = tg.members.filter((m) => m.user_id === u.id).map((m) => {
      const c = tg.circles.get(m.circle_id); const msgs = tg.messages.filter((g) => g.circle_id === c.id);
      const last = msgs[msgs.length - 1];
      return { at: last ? last.created_at : c.created_at, j: {
        id: c.id, name: c.name, kind: c.kind, role: m.role, created_at: c.created_at,
        unread: msgs.filter((g) => g.created_at > m.last_read_at && g.author_id !== u.id).length,
        last: last ? { body: last.body, at: last.created_at, author_id: last.author_id } : null,
        members: tg.members.filter((x) => x.circle_id === c.id).map((x) => ({ user_id: x.user_id, role: x.role, name: nameOf(x.user_id) })),
        pending: tg.invites.filter((i) => i.circle_id === c.id).map((i) => ({ id: i.id, email: i.email })),
      } };
    });
    return out.sort((a, b) => (a.at < b.at ? 1 : -1)).map((x) => x.j);
  },
  orbita_mark_read: (u, a) => { const m = tg.members.find((x) => x.circle_id === a.p_circle && x.user_id === u.id); if (m) m.last_read_at = nowIso(); return null; },
  orbita_messages: (u, a) => {
    if (!isMember(a.p_circle, u.id)) bad('You are not in that chat.');
    let list = tg.messages.filter((g) => g.circle_id === a.p_circle && (!a.p_after || g.created_at > a.p_after));
    list = list.slice(-Math.min(Math.max(a.p_limit || 100, 1), 200));
    return list.map((g) => ({ id: g.id, author_id: g.author_id, mine: g.author_id === u.id, author_name: nameOf(g.author_id), body: g.body, created_at: g.created_at }));
  },
  orbita_send_message: (u, a) => {
    if (!isMember(a.p_circle, u.id)) bad('You are not in that chat.');
    const b = String(a.p_body || '').trim(); if (b.length < 1 || b.length > 4000) bad('Messages can be 1 to 4000 characters.');
    const g = { id: uuid(), circle_id: a.p_circle, author_id: u.id, body: b, created_at: nowIso() };
    tg.messages.push(g);
    const m = tg.members.find((x) => x.circle_id === a.p_circle && x.user_id === u.id); m.last_read_at = g.created_at;
    return { id: g.id, created_at: g.created_at };
  },
  orbita_save_entry: (u, a) => {
    const body = String(a.p_body || '').trim(); if (!body) bad('Write something first (up to 20000 characters).');
    (a.p_circles || []).forEach((c) => { if (!isMember(c, u.id)) bad('You can only share into groups you are in.'); });
    const people = [...new Map((a.p_people || []).map((n) => String(n).trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    let e;
    if (a.p_id) { e = tg.entries.find((x) => x.id === a.p_id && x.author_id === u.id); if (!e) bad('You can only edit your own memories.'); }
    else { e = { id: uuid(), author_id: u.id, created_at: nowIso() }; tg.entries.push(e); }
    Object.assign(e, { title: String(a.p_title || '').trim() || null, body, happened_on: a.p_happened_on || new Date().toISOString().slice(0, 10), place: String(a.p_place || '').trim() || null, people, updated_at: nowIso() });
    tg.shares = tg.shares.filter((s) => s.entry_id !== e.id).concat((a.p_circles || []).map((c) => ({ entry_id: e.id, circle_id: c })));
    return e.id;
  },
  orbita_journal: (u, a) => {
    if (a.p_circle && !isMember(a.p_circle, u.id)) bad('You are not in that group.');
    const mine = (e) => tg.shares.filter((s) => s.entry_id === e.id && isMember(s.circle_id, u.id)).map((s) => s.circle_id);
    return tg.entries.filter((e) => (e.author_id === u.id || mine(e).length)
      && (!a.p_circle || tg.shares.some((s) => s.entry_id === e.id && s.circle_id === a.p_circle))
      && (!a.p_person || e.people.some((n) => n.toLowerCase() === String(a.p_person).trim().toLowerCase())))
      .sort((x, y) => (x.happened_on === y.happened_on ? (x.created_at < y.created_at ? 1 : -1) : (x.happened_on < y.happened_on ? 1 : -1)))
      .slice(0, 200)
      .map((e) => ({ id: e.id, author_id: e.author_id, mine: e.author_id === u.id, author_name: nameOf(e.author_id), title: e.title, body: e.body, happened_on: e.happened_on, place: e.place, people: e.people, created_at: e.created_at, updated_at: e.updated_at,
        circles: mine(e).map((cid) => { const c = tg.circles.get(cid); return { id: c.id, name: c.name, kind: c.kind }; }) }));
  },
  orbita_delete_my_together_data: (u) => {
    tg.entries = tg.entries.filter((e) => e.author_id !== u.id); tg.messages = tg.messages.filter((g) => g.author_id !== u.id);
    tg.members = tg.members.filter((m) => m.user_id !== u.id); tg.names.delete(u.id); return null;
  },
};


http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);
  if (p === '/__reset') { reset(); return send(res, 200, { ok: true }); }
  if (p === '/__fail') { failing = url.searchParams.get('on') === '1'; return send(res, 200, { failing }); }
  if (p === '/__ttl') { ttl = parseInt(url.searchParams.get('seconds'), 10) || 3600; return send(res, 200, { ttl }); }
  if (p === '/__last_recovery') return send(res, 200, { link: lastRecovery });
  if (failing) return send(res, 503, { message: 'mock is offline' });
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};


  // ---------------- Together endpoints ----------------
  if (p.startsWith('/rest/v1/rpc/')) {
    const user = authed(req);
    if (!user) return send(res, 401, { message: 'JWT expired', code: 'PGRST301' });
    const fn = TG[p.slice('/rest/v1/rpc/'.length)];
    if (!fn) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${p.slice(13)} in the schema cache` });
    try { const out = fn(user, body); return send(res, 200, out === undefined ? null : out); } catch (e) { if (e instanceof Fail) return send(res, 400, { code: 'P0001', message: e.message }); throw e; }
  }
  if ((p === '/rest/v1/orbita_messages' || p === '/rest/v1/orbita_entries') && req.method === 'DELETE') {
    const user = authed(req); if (!user) return send(res, 401, { message: 'JWT expired' });
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    if (p.endsWith('messages')) tg.messages = tg.messages.filter((g) => !(g.id === id && g.author_id === user.id));
    else { const mine = tg.entries.find((e) => e.id === id && e.author_id === user.id); if (mine) { tg.entries = tg.entries.filter((e) => e !== mine); tg.shares = tg.shares.filter((s) => s.entry_id !== id); } }
    return send(res, 204);
  }

  // ---------------- feedback box ----------------
  if (p === '/__feedback') return send(res, 200, feedback);
  if (p === '/rest/v1/orbita_feedback' && req.method === 'POST') {
    if (!body.message || String(body.message).length > 4000) return send(res, 400, { message: 'new row violates check constraint "orbita_feedback_len"' });
    feedback.push({ ...body, at: Date.now() });
    return send(res, 201);
  }

  // ---------------- auth ----------------
  if (p === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 422, { msg: 'Unable to validate email address: invalid format' });
    if (String(body.password || '').length < 8) return send(res, 422, { msg: 'Password should be at least 8 characters.' });
    if (users.has(email)) return send(res, 200, { id: uuid(), email, identities: [] }); // real Supabase hides existing accounts
    const user = { id: uuid(), email, password: body.password, confirmed: !CONFIRM };
    users.set(email, user);
    return send(res, 200, CONFIRM ? { id: user.id, email, confirmation_sent_at: new Date().toISOString() } : issue(user));
  }
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = users.get(String(body.email || '').toLowerCase());
      if (!u || u.password !== body.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      if (!u.confirmed) return send(res, 400, { error: 'invalid_grant', error_description: 'Email not confirmed' });
      return send(res, 200, issue(u));
    }
    if (grant === 'refresh_token') {
      const s = sessions.get(body.refresh_token);
      if (!s || !s.refresh) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
      sessions.delete(body.refresh_token);
      return send(res, 200, issue(s.user));
    }
  }
  if (p === '/auth/v1/logout' && req.method === 'POST') { sessions.delete((req.headers.authorization || '').replace(/^Bearer /, '')); return send(res, 204); }
  if (p === '/auth/v1/recover' && req.method === 'POST') {
    const u = users.get(String(body.email || '').toLowerCase());
    if (u) {
      const s = issue(u);
      lastRecovery = `${url.searchParams.get('redirect_to') || ''}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=${ttl}&token_type=bearer&type=recovery`;
    }
    return send(res, 200, {});
  }
  if (p === '/auth/v1/user') {
    const user = authed(req);
    if (!user) return send(res, 401, { msg: 'invalid JWT: unable to parse or verify signature, token is expired' });
    if (req.method === 'GET') return send(res, 200, { id: user.id, email: user.email });
    if (req.method === 'PUT') {
      if (String(body.password || '').length < 8) return send(res, 422, { msg: 'Password should be at least 8 characters.' });
      user.password = body.password; return send(res, 200, { id: user.id, email: user.email });
    }
  }

  // ---------------- orbita_data (row-level security: your own row only) ----------------
  if (p === '/rest/v1/orbita_data') {
    const user = authed(req);
    if (!user) return send(res, 401, { message: 'JWT expired', code: 'PGRST301' });
    const eq = (k) => { const v = url.searchParams.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
    const wantUser = eq('user_id');
    const wantVersion = eq('version');
    const own = rows.get(user.id);
    if (req.method === 'GET') {
      if (wantUser && wantUser !== user.id) return send(res, 200, []); // RLS hides other people's rows
      return send(res, 200, own ? [{ data: own.data, version: own.version }] : []);
    }
    if (req.method === 'POST') {
      if (body.user_id !== user.id) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "orbita_data"' });
      if (own) return send(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "orbita_data_pkey"' });
      if (!Array.isArray(body.data)) return send(res, 400, { code: '23514', message: 'new row violates check constraint "orbita_data_is_list"' });
      rows.set(user.id, { data: body.data, version: body.version || 1 });
      return send(res, 201, [{ user_id: user.id, data: body.data, version: body.version || 1 }]);
    }
    if (req.method === 'PATCH') {
      if (!own || (wantUser && wantUser !== user.id)) return send(res, 200, []);
      if (wantVersion && String(own.version) !== wantVersion) return send(res, 200, []); // lost the race
      if (!Array.isArray(body.data)) return send(res, 400, { code: '23514', message: 'check constraint violated' });
      own.data = body.data; own.version = body.version;
      return send(res, 200, [{ user_id: user.id, data: own.data, version: own.version }]);
    }
    if (req.method === 'DELETE') { rows.delete(user.id); return send(res, 204); }
  }
  send(res, 404, { message: `no route for ${req.method} ${p}` });
}).listen(54321, () => console.log('mock supabase on http://localhost:54321' + (CONFIRM ? ' (email confirmation required)' : '')));
