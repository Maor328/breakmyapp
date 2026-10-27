// The HARDENED twin of demo/server.mjs — same routes, every bug fixed.
// Point Break My App at it and it should score 100 / A. Zero dependencies, Node 18+.
// Each fix is labelled with the attacker it defeats.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const SECRET = 'demo-secret-change-me';
const users = [{ id: 1, name: 'Dana' }, { id: 2, name: 'Lior' }];
const orders = { 1: { id: 1, item: 'book', owner: 'dana@demo.test' }, 2: { id: 2, item: 'laptop', owner: 'lior@demo.test' } };

// --- helpers ---
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); // defeats The Mirror (XSS)
const b64u = (b) => Buffer.from(b).toString('base64url');
function readBody(req, limit = 100 * 1024) { // defeats The Heavyweight (no body limit)
  return new Promise((resolve) => {
    let len = 0, over = false; const chunks = [];
    req.on('data', (c) => { len += c.length; if (len > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); }); // drain, don't destroy, so the client gets a clean 413 (not a reset)
    req.on('end', () => resolve(over ? { __over: true } : Buffer.concat(chunks).toString()));
    req.on('error', () => resolve({ __over: true }));
  });
}
function safeParse(s) { // defeats The Polluter (prototype pollution) + The Type Confuser (clean 400s)
  const o = JSON.parse(s, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw Object.assign(new Error('expected object'), { code: 400 });
  return o;
}
function sign(payload) { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64u(JSON.stringify(payload)); const d = `${h}.${p}`; return `${d}.${crypto.createHmac('sha256', SECRET).update(d).digest('base64url')}`; }
function verify(tok) { // defeats The Impersonator (alg:none / stripped signature)
  if (!tok) return null; const parts = tok.split('.'); if (parts.length !== 3) return null;
  let hd; try { hd = JSON.parse(Buffer.from(parts[0], 'base64url')); } catch { return null; }
  if (hd.alg !== 'HS256') return null;
  const exp = crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (parts[2].length !== exp.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(exp))) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { return null; }
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

// rate limiter for the login route — defeats The Bouncer (no rate limit) & slows credential stuffing
const loginHits = [];
function loginLimited() { const now = Date.now(); while (loginHits.length && loginHits[0] < now - 10000) loginHits.shift(); loginHits.push(now); return loginHits.length > 20; }

const server = http.createServer(async (req, res) => {
  // security headers on every response — defeats The Gatekeeper (headers/clickjacking) & The Header Goblin (no version banner: we never set x-powered-by)
  const SEC = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };
  const send = (code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, ...SEC, ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

  try {
    // validate Host — defeats The Impostor (host-header injection)
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return send(400, { error: 'bad host' });

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method;

    if (path === '/' && method === 'GET') {
      return send(200, `<!doctype html><title>Secure Demo</title><h1>Secure Demo</h1>
<a href="/api/users">users</a> <a href="/api/search?q=a">search</a> <a href="/api/account">account</a> <a href="/api/orders/1">order</a> <a href="/api/hello?q=hi">hello</a> <a href="/api/login">login</a>`, 'text/html');
    }

    // login: strings only (defeats The Keymaster / NoSQL bypass), rate-limited, signed JWT
    if (path === '/api/login') {
      if (method === 'GET') return send(200, { hint: 'POST {email, password} to log in' });
      if (method !== 'POST') return send(405, { error: 'method not allowed' });
      if (loginLimited()) return send(429, { error: 'too many attempts, slow down' });
      const raw = await readBody(req); if (typeof raw !== 'string') return send(413, { error: 'payload too large' });
      let body; try { body = safeParse(raw); } catch { return send(400, { error: 'bad request' }); }
      if (typeof body.email !== 'string' || typeof body.password !== 'string') return send(401, { error: 'invalid credentials' });
      if (body.password !== 'secret') return send(401, { error: 'invalid credentials' });
      const token = sign({ sub: body.email });
      return send(200, { accessToken: token }, 'application/json', { 'set-cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/` }); // secure cookie
    }

    // public, validated
    if (path === '/api/users' && method === 'GET') return send(200, users);
    if (path === '/api/users') return send(405, { error: 'method not allowed' });

    if (path === '/api/search') {
      if (method !== 'GET') return send(405, { error: 'method not allowed' });
      const q = url.searchParams.get('q'); if (typeof q !== 'string' || q.length > 200) return send(400, { error: 'bad query' });
      return send(200, { results: users.filter((u) => u.name.includes(q)) }); // JSON, no template/HTML — no SSTI/XSS
    }

    if (path === '/api/hello') {
      if (method !== 'GET') return send(405, { error: 'method not allowed' });
      return send(200, `<!doctype html><p>hi ${esc(url.searchParams.get('q') || '')}</p>`, 'text/html'); // escaped — defeats The Mirror
    }

    // protected: require a verified token — defeats The Infiltrator (missing authz)
    if (path === '/api/account') {
      if (method !== 'GET') return send(405, { error: 'method not allowed' });
      const u = verify(bearer(req)); if (!u) return send(401, { error: 'login required' });
      return send(200, { email: u.sub, name: 'Dana' });
    }

    // object-level auth: you only see your own order — defeats The Enumerator (BOLA/IDOR)
    const ord = path.match(/^\/api\/orders\/(\d+)$/);
    if (ord) {
      if (method !== 'GET') return send(405, { error: 'method not allowed' });
      const u = verify(bearer(req)); if (!u) return send(401, { error: 'login required' });
      const o = orders[ord[1]]; if (!o) return send(404, { error: 'no order' });
      if (o.owner !== u.sub) return send(403, { error: 'not your order' });
      return send(200, o);
    }

    // state change: authed + serialized so concurrent requests can't collide — defeats The Racer (lost update)
    if (path === '/api/pay') {
      if (method !== 'POST') return send(405, { error: 'method not allowed' });
      const u = verify(bearer(req)); if (!u) return send(401, { error: 'login required' });
      const raw = await readBody(req); if (typeof raw !== 'string') return send(413, { error: 'payload too large' });
      let body; try { body = safeParse(raw); } catch { return send(400, { error: 'bad request' }); }
      const amount = Number(body.amount); if (!Number.isFinite(amount) || amount < 0) return send(400, { error: 'bad amount' });
      const bal = await payNext(amount);
      return send(200, { balance: bal });
    }

    // safe redirect: relative paths only — defeats The Redirector (open redirect)
    if (path === '/go' && method === 'GET') {
      const next = url.searchParams.get('next') || '/';
      if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return send(400, { error: 'bad redirect' });
      return send(302, '', 'text/plain', { location: next });
    }

    // explicit field binding — defeats The Overshare (mass assignment). No role/isAdmin honoured.
    if (path === '/api/register' && method === 'POST') {
      const raw = await readBody(req); if (typeof raw !== 'string') return send(413, { error: 'payload too large' });
      let body; try { body = safeParse(raw); } catch { return send(400, { error: 'bad request' }); }
      if (typeof body.name !== 'string') return send(400, { error: 'name required' });
      return send(201, { id: users.length + 1, name: body.name }); // only name is bound
    }

    return send(404, { error: 'not found' }); // no /.env, /graphql, /actuator, /api/file, etc. — defeats Snoop/Cartographer/Spelunker/Traverser/Portal/Archivist/Smith
  } catch (e) { // global boundary — defeats The Fuzzer/Type Confuser crashes & stack-leak (never leak e.stack)
    return send(500, { error: 'internal error', id: crypto.randomUUID() });
  }
});

// serialize the balance updates
let balance = 100, payChain = Promise.resolve();
function payNext(amount) { payChain = payChain.then(async () => { const cur = balance; await new Promise((r) => setTimeout(r, 3)); balance = cur - amount; return balance; }); return payChain; }

server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} }); // never crash on malformed TCP
server.listen(PORT, () => console.log(`secure demo app on http://localhost:${PORT}`));
