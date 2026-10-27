# 💥 Break My App

![Break My App](logo.svg)

![survived](breakmyapp-badge.svg)

Point it at your app. Watch it try to break it — live in your terminal. Get a survival score, a README badge, an animated replay, and for every failure **why it matters and how to fix it.**

![demo run](breakmyapp-cast.svg)

```bash
npx breakmyapp localhost:3000
```

Zero dependencies. Node 18+. One command.

**New here? Read `START-HERE.md` — a step-by-step guide for total beginners.**

## 27 attackers — a full OWASP-style sweep

| Attacker | What it hunts |
|---|---|
| 🧪 The Fuzzer | SQL-ish, XSS, 100KB strings, control chars, traversal, unicode floods |
| 🪞 The Mirror | reflected XSS (unescaped input in an HTML response) |
| 🎭 The Type Confuser | null, arrays, bare values, wrong types, truncated & deeply nested JSON |
| 🗿 The Interrogator | server-side template injection (SSTI → often RCE) |
| ⚒️ The Smith | OS command injection (marker echo + blind `sleep` timing) |
| 🛰️ The Portal | SSRF reaching cloud-metadata endpoints |
| 📜 The Archivist | XXE — XML external-entity file reads |
| 🧬 The Polluter | `__proto__` / `constructor` prototype pollution (confirmed) |
| 🗂️ The Traverser | path traversal / LFI (`../../etc/passwd`, encodings, null bytes) |
| ✂️ The Smuggler | CRLF header injection / HTTP response splitting |
| ↪️ The Redirector | open redirects (`?next=//evil.com`) |
| 🪪 The Impostor | Host-header injection (cache / password-reset poisoning) |
| 🎁 The Overshare | mass assignment (`role`, `isAdmin` accepted) |
| 🔨 The Method Menace | PUT / DELETE / PATCH / OPTIONS / TRACE handling |
| 👺 The Header Goblin | giant cookies, broken multipart, spoofed forwarded-host, version banners |
| 🏋️ The Heavyweight | 5MB body with no size cap |
| 🐌 The Slowburn | ReDoS / algorithmic-complexity timing |
| 🔢 The Enumerator | broken object-level auth (IDOR / BOLA) *(with auth)* |
| 🎫 The Impersonator | forged JWTs — `alg:none`, stripped signature *(with a JWT)* |
| 🏁 The Racer | 25 concurrent requests — crashes & lost updates (double-spend) |
| 🔎 The Snoop | exposed `.env` / `.git` / backups, secrets in responses |
| 🗺️ The Cartographer | GraphQL introspection left on in production |
| 🔦 The Spelunker | exposed debug/management endpoints (actuator, phpinfo, metrics) |
| 🧱 The Gatekeeper | security headers, clickjacking, CORS, insecure cookies |
| 🗝️ The Keymaster | NoSQL auth bypass (`{"$ne":null}` login) |
| 🚪 The Bouncer | missing rate limiting on sensitive routes |
| 🕵️ The Infiltrator | replays every route with **no credentials** *(with auth)* |

After every round it checks your server is still alive. If it died, you get an **F**.

## Authentication

So it can reach your logged-in routes:

```bash
--bearer <token>                  # Authorization: Bearer <token>
--cookie "session=abc123"
--header "X-API-Key: ..."          # repeatable

# or log in and capture the session automatically:
--login-url /api/login \
--login-body '{"email":"me@app.test","password":"secret"}' \
--token-path data.accessToken      # Set-Cookie is captured too
```

With auth set, **The Infiltrator**, **The Enumerator** and **The Impersonator** also run.

## Output

```
--report <file.html>  interactive HTML report that opens in your browser
--badge <file>        SVG badge for your README
--cast <file.svg>     animated replay of the run (loops, embeds in a README)
--json <file>         full report + fixes, machine-readable
--no-open             don't auto-open the HTML report
--no-fixes            hide the how-to-fix section
```

The HTML report (`--report report.html`) is the nicest way to read results: a score ring, the target's profile, every attacker marked clean / found / skipped, and each finding with a plain-language *why* and *how to fix*, filterable by severity.

Every run ends with findings grouped by category, each with `why:` and `fix:` in plain language.

## Try it

```bash
node demo/server.mjs &     # a deliberately flawed app (~20 planted bugs)
npx breakmyapp localhost:3000 \
  --routes /api/file,/go,/api/orders/1,/api/greet,/api/ping,/api/fetch,/api/import,/api/hello \
  --login-url /api/login --login-body '{"email":"me@demo.test","password":"secret"}' --token-path accessToken \
  --report report.html
```

The demo scores ~5/100 and the tool explains every planted bug.

### The two demos: before & after

The repo ships a matched pair so you can see every fix in action:

- **`demo/server.mjs`** — the vulnerable app. ~20 planted bugs → **score ~5 / F**.
- **`demo/secure-server.mjs`** — the hardened twin, same routes, every bug fixed (input validation, body-size limit, safe JSON parse, verified JWTs, enforced authorization, object-ownership checks, serialized writes, rate limiting, security headers, escaped output). → **score 100 / A, zero findings.**

```bash
node demo/secure-server.mjs &
npx breakmyapp localhost:3000 --routes /go,/api/orders/1 \
  --login-url /api/login --login-body '{"email":"dana@demo.test","password":"secret"}' --token-path accessToken \
  --report report.html
```

Read `demo/secure-server.mjs` top to bottom — each fix is commented with the attacker it defeats. It doubles as a checklist for hardening your own app.

## Install & publish

- **`START-HERE.md`** — the beginner guide (install, folders, upload to GitHub, no commands).
- **`PUBLISHING.md`** — the full version: global install, npm (`npx breakmyapp`), GitHub via CLI, versioning.
- **`.github/workflows/breakmyapp.yml`** — a ready CI job that runs the tool on every push and fails the build on a critical finding (edit the one line that starts your app). The CLI exits non-zero on any critical or if the server dies.

## What it is — and isn't

Break My App is an HTTP(S) **dynamic tester** for apps you are building or running — like a friendlier OWASP ZAP you run in one line. If a desktop app exposes a local HTTP API, point it at that `localhost` port; it does not drive native GUI apps.

## Safety — read before running on anything public

- **Localhost only by default.** Any other host needs `--i-own-this`. Use it **only** on an app you own or are authorized to test (your own deployment, or a target inside a bug-bounty program's defined scope). Fuzzing someone else's service without authorization is a crime (CFAA, Israel's Computer Law 5755-1995, and equivalents) — intent doesn't matter.
- It sends real `POST`/`PUT`/`DELETE` traffic and can change or destroy data. **Dev/staging only, never production.**
- Attacks mutate state, so later findings may be side effects of earlier ones. Restart your app between runs.
- If you publish this, **keep the localhost guard** — do not turn it into a hosted service that fuzzes arbitrary user-supplied URLs.
- A first-pass QA aid, not a substitute for a real security audit or pen test. SSRF, ReDoS, lost-update, BOLA, mass-assignment and prototype-pollution checks are heuristics — treat findings as leads to verify.

## License

MIT
