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

let users, sessions, rows, lastRecovery, failing, ttl;
const reset = () => { users = new Map(); sessions = new Map(); rows = new Map(); lastRecovery = null; failing = false; ttl = 3600; };
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
