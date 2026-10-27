// A deliberately flawed demo app for Break My App. Run it, then point breakmyapp at it.
// It plants ~20 classic bugs on purpose so you can see what each attacker finds. Never ship anything like this.
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const users = [{ id: 1, name: 'Dana' }, { id: 2, name: 'Lior' }];
const orders = { 1: { id: 1, item: 'book', owner: 'dana' }, 2: { id: 2, item: 'laptop', owner: 'lior' } };
let balance = 100;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
function merge(dst, src) { for (const k in src) { if (typeof src[k] === 'object' && src[k]) { dst[k] = dst[k] || {}; merge(dst[k], src[k]); } else dst[k] = src[k]; } return dst; }
// naive "template engine": evaluates {{a*b}} / ${a*b} / #{a*b} — simulates SSTI
const render = (s) => String(s).replace(/(?:\{\{|\$\{|#\{|<%=)\s*(\d+)\s*\*\s*(\d+)\s*(?:\}\}|\}|%>)/g, (_, a, c) => a * c);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('x-powered-by', 'DemoStack/1.4.2'); // version banner, no security headers
  const send = (c, o, t = 'application/json') => { res.writeHead(c, { 'content-type': t }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };

  try {
    if (url.pathname === '/') {
      res.setHeader('set-cookie', 'session=abc123; Path=/'); // insecure cookie
      return send(200, `<h1>Demo</h1><link href="http://${req.headers.host}/reset"><a href="/api/users">users</a> <a href="/api/search">search</a> <a href="/api/pay">pay</a> <a href="/api/account">account</a> <a href="/api/orders/1">order</a> <a href="/api/greet">greet</a> <a href="/api/ping">ping</a> <a href="/api/hello">hello</a>`, 'text/html');
    }
    if (url.pathname === '/.env') return send(200, 'API_KEY=sk_live_demo123\nDB_PASSWORD=hunter2\n', 'text/plain');
    if (url.pathname === '/actuator/env') return send(200, { activeProfiles: ['prod'], propertySources: [{ name: 'systemEnvironment' }] });
    if (url.pathname === '/graphql' && req.method === 'POST') { const b = await readBody(req); if (/__schema|IntrospectionQuery/.test(b)) return send(200, { data: { __schema: { types: [{ name: 'User' }, { name: 'Order' }] } } }); return send(400, { error: 'bad query' }); }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const token = { accessToken: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: String(body.email || 'anon') })}.demosig` };
      if (typeof body.email === 'object' || typeof body.password === 'object') return send(200, token); // NoSQL bypass
      if (body.password === 'secret') return send(200, token);
      return send(401, { error: 'bad credentials' });
    }
    if (url.pathname === '/api/account') return send(200, { id: 1, name: 'Dana', secret: 'balance:' + balance }); // "protected" but never checks auth

    if (url.pathname === '/api/greet') return send(200, { msg: 'hello ' + render(url.searchParams.get('q') || url.searchParams.get('name') || '') }, 'application/json'); // SSTI sink
    if (url.pathname === '/api/hello') return send(200, `<p>hi ${url.searchParams.get('q') || url.searchParams.get('name') || ''}</p>`, 'text/html'); // reflected XSS sink
    if (url.pathname === '/api/ping') { const h = url.searchParams.get('host') || ''; const m = h.match(/echo (bmapCMD\w+)/); return send(200, { out: 'PING ' + (m ? m[1] : h) }); } // command-injection sink (echoes marker)
    if (url.pathname === '/api/fetch') { const u = url.searchParams.get('url') || ''; if (/169\.254\.169\.254|metadata/.test(u)) return send(200, { fetched: '{"AccessKeyId":"ASIA_demo","Token":"meta"}' }); return send(200, { fetched: '' }); } // SSRF sink
    if (url.pathname === '/api/import' && req.method === 'POST') { const b = await readBody(req); if (/<!ENTITY.+SYSTEM.+file:\/\/\/etc\/passwd/.test(b)) return send(200, 'root:x:0:0:root:/root:/bin/bash\n', 'text/plain'); return send(200, { imported: true }); } // XXE sink
    if (url.pathname === '/api/file') { const p = url.searchParams.get('file') || url.searchParams.get('path') || ''; if (/passwd/.test(p)) return send(200, 'root:x:0:0:root:/root:/bin/bash\n', 'text/plain'); return send(200, { file: p }); } // LFI sink
    if (url.pathname === '/go') { res.writeHead(302, { location: url.searchParams.get('next') || '/' }); return res.end(); } // open redirect

    const ord = url.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (ord) { const o = orders[ord[1]]; return o ? send(200, o) : send(404, { error: 'no order' }); } // BOLA: no ownership check

    if (url.pathname === '/api/users' && req.method === 'GET') { const id = url.searchParams.get('id'); if (id && /[<>']/.test(id)) throw new TypeError(`SQLITE_ERROR: unrecognized token near "${id.slice(0, 20)}"`); return send(200, users); }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req)); const obj = merge({}, parsed);
      const inh = Object.keys(Object.prototype).find((k) => k.startsWith('bmap_pp_')); if (inh) return send(200, { ok: true, polluted: inh });
      if (obj.role || obj.isAdmin || obj.verified) return send(201, { id: 99, name: obj.name, role: obj.role, isAdmin: obj.isAdmin, verified: obj.verified }); // mass assignment echo
      users.push({ id: users.length + 1, name: obj.name }); return send(201, users[users.length - 1]);
    }
    if (url.pathname === '/api/search') { const q = url.searchParams.get('q') || ''; return send(200, { results: users.filter((u) => u.name.includes(q)), echo: render(q) }); }
    if (url.pathname === '/api/pay' && req.method === 'POST') { const { amount } = JSON.parse(await readBody(req) || '{}'); const cur = balance; await new Promise((r) => setTimeout(r, 5)); balance = cur - Number(amount || 0); return send(200, { balance }); }

    return send(404, { error: 'not found' });
  } catch (e) { return send(500, `${e.stack}`, 'text/plain'); } // leaks stack
});
server.listen(PORT, () => console.log(`demo app on http://localhost:${PORT}`));
