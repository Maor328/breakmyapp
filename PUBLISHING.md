# Installing & publishing Break My App

Four stages, from "run it on my machine" to "anyone in the world runs it with one command."

---

## 1. Run it yourself (no install)

You already have the files. From the project folder:

```bash
node bin/breakmyapp.mjs localhost:3000
```

That's it — zero dependencies, nothing to install. Node 18 or newer is the only requirement (`node --version`).

Try the full demo:

```bash
node demo/server.mjs &                 # starts the deliberately-broken app on :3000
node bin/breakmyapp.mjs localhost:3000 --routes /api/file,/go,/api/orders/1 \
  --login-url /api/login --login-body '{"email":"me@demo.test"}' --token-path accessToken \
  --cast cast.svg
kill %1                                 # stop the demo app
```

---

## 2. Install it globally on your machine

So you can type `breakmyapp` from any folder:

```bash
cd breakmyapp
npm install -g .          # or: npm link
breakmyapp localhost:3000
```

Uninstall with `npm rm -g breakmyapp`. (The `bin` field in `package.json` is what makes the `breakmyapp` command work.)

---

## 3. Publish to npm → anyone runs `npx breakmyapp`

This is the "others use it" path most people expect.

**One-time setup**
1. Create a free account at npmjs.com.
2. `npm login` in your terminal.
3. Pick a name that's free: `npm view breakmyapp`. If it's taken, rename the `"name"` in `package.json` (e.g. `@yourname/breakmyapp` — a scoped name is almost always free).

**Publish**
```bash
npm publish --access public      # --access public is required for scoped names
```

**Now anyone can run it without installing anything:**
```bash
npx breakmyapp localhost:3000
# or install it: npm i -g breakmyapp
```

**Updating:** bump the version and publish again (npm refuses to republish the same version):
```bash
npm version patch                # 0.3.0 → 0.3.1  (patch / minor / major)
npm publish
```

Only the files listed under `"files"` in `package.json` (`bin`, `README.md`) ship — the demo and docs stay out of the published package, which is what you want.

---

## 4. Publish on GitHub → stars, issues, the badge

```bash
cd breakmyapp
git init && git add -A && git commit -m "Break My App v0.3.0"

# with the GitHub CLI (easiest):
gh repo create breakmyapp --public --source=. --push

# or create the repo on github.com, then:
git remote add origin https://github.com/<you>/breakmyapp.git
git push -u origin main
```

People can then run it straight from the repo, no npm needed:
```bash
npx github:<you>/breakmyapp localhost:3000
```

**Make the README sell it.** The repo already embeds two things that render on GitHub:
- `![survived](breakmyapp-badge.svg)` — the grade badge.
- `![demo run](breakmyapp-cast.svg)` — the animated replay (GitHub plays SMIL-animated SVGs in READMEs).

Regenerate both against your own demo before pushing so the README shows a real run:
```bash
node demo/server.mjs &
node bin/breakmyapp.mjs localhost:3000 --routes /api/file,/go,/api/orders/1 \
  --login-url /api/login --login-body '{"email":"me@demo.test"}' --token-path accessToken \
  --badge breakmyapp-badge.svg --cast breakmyapp-cast.svg
kill %1
```

Add topics (`security`, `fuzzing`, `testing`, `cli`), and you're done.

---

## How other people use it on their own apps

Tell them this much:

```bash
# simplest
npx breakmyapp localhost:3000

# an app behind login
npx breakmyapp localhost:3000 \
  --login-url /api/login --login-body '{"email":"you@app.test","password":"..."}' \
  --token-path data.accessToken

# save a badge + shareable animation + JSON report
npx breakmyapp localhost:3000 --badge badge.svg --cast run.svg --json report.json
```

And the one rule that keeps it legitimate: **localhost only unless you pass `--i-own-this`, and only on apps you own or are authorized to test.** Keep that guard in any fork.

---

## Optional niceties before you ship

- Add a `LICENSE` file (MIT text) — `package.json` already says MIT.
- Add a GitHub Action that runs `breakmyapp` against a spun-up dev server and fails the build on a critical finding (the tool exits non-zero on any critical or if the server dies).
- Add a short `CONTRIBUTING.md` inviting new attackers — each one is just an entry in the `attackers` array.
