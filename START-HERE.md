# 🚀 Start here — the super simple guide

No experience needed. Follow the steps in order. If a step doesn't apply, skip it.

---

## Part 1 — Get the tool running on your computer

### Step 1: Install Node (you only do this once)

Node is the program that runs Break My App.

1. Go to **https://nodejs.org**
2. Click the big green button that says **"LTS"**.
3. Open the file it downloaded and click **Next → Next → Install** until it finishes.

To check it worked: open your **Terminal** (on Windows: search "PowerShell"; on Mac: search "Terminal"), type this, and press Enter:

```
node --version
```

If you see a number like `v20.11.0`, you're good. 🎉

### Step 2: Put the files in one folder

Make a folder on your Desktop called **breakmyapp**. Inside it, arrange the files exactly like this:

```
breakmyapp/            ← the folder
├── bin/
│   └── breakmyapp.mjs     ← the tool
├── demo/
│   └── server.mjs         ← the practice app
├── package.json
├── README.md
├── START-HERE.md          ← this file
└── PUBLISHING.md
```

`bin` and `demo` are folders — make them and drop the matching file inside each. Everything else sits loose in the main folder.

### Step 3: Open the Terminal _in that folder_

- **Windows:** open the `breakmyapp` folder, click the address bar at the top, type `powershell`, press Enter.
- **Mac:** right-click the `breakmyapp` folder → **Services** → **New Terminal at Folder**.

### Step 4: Try it on the practice app

Type these two lines (press Enter after each):

```
node demo/server.mjs
```

Leave that running. Open a **second** Terminal the same way (Step 3) and type:

```
node bin/breakmyapp.mjs localhost:3000
```

You'll see the attackers run and a score at the end. That's it — you just broke an app on purpose. 💥

To stop the practice app, click its Terminal and press **Ctrl + C**.

---

## Part 2 — Use it on your own app

Start your own app however you normally do (so it's running at, say, `localhost:3000`), then:

```
node bin/breakmyapp.mjs localhost:3000 --report report.html
```

`--report report.html` makes a nice web page (it opens by itself in your browser) with the score, every attacker, and clear fix steps — much easier to read than the terminal. Drop `--report report.html` if you just want the terminal output.

If your app needs a login, add your login details:

```
node bin/breakmyapp.mjs localhost:3000 --login-url /api/login --login-body "{\"email\":\"you@app.com\",\"password\":\"yourpassword\"}" --token-path accessToken
```

⚠️ **Only ever run this on an app that is yours** (or one you have written permission to test). Point it only at `localhost` or your own server. Don't run it on other people's websites — that's illegal.

---

## Part 3 — Put it on GitHub (so others can use it)

The easy way, all from the website — no commands.

### Step 1: Make a free GitHub account

Go to **https://github.com** and sign up.

### Step 2: Create an empty project

1. Click the **+** at the top right → **New repository**.
2. Name it **breakmyapp**.
3. Choose **Public**.
4. Click **Create repository**.

### Step 3: Upload your files

1. On the new page, click the link **"uploading an existing file"**.
2. Open your `breakmyapp` folder on your computer, select **everything inside it**, and **drag it onto the web page**.
   - The `bin` and `demo` folders drag over with their files inside — GitHub keeps the folders.
3. Scroll down and click the green **Commit changes** button.

Done. Your project now lives at `https://github.com/YOUR-NAME/breakmyapp`.

### Step 4 (optional): let people run it with one line

Once it's on GitHub, anyone can run it without downloading anything:

```
npx github:YOUR-NAME/breakmyapp localhost:3000
```

---

## Do I need to zip anything?

**No.** For GitHub you upload the files directly (Step 3 above) — don't zip them.

The only time you'd make a ZIP is if you want to **email** the tool to someone:

1. Select the `breakmyapp` folder.
2. **Windows:** right-click → **Send to → Compressed (zipped) folder.**
   **Mac:** right-click → **Compress.**
3. Send the resulting `breakmyapp.zip`. They unzip it and start at Step 1 of this guide.

---

## If something goes wrong

- **"node is not recognized"** → Node isn't installed yet, or you need to close and reopen the Terminal. Redo Part 1, Step 1.
- **"Cannot reach localhost:3000"** → your app (or the demo) isn't running, or it's on a different number. Start it first, and use the number it prints.
- **"Refusing to attack …"** → you pointed it at a site that isn't localhost. That's the safety guard. Only test your own apps.

Want the deeper version (publishing to npm, versioning, GitHub via commands)? See **PUBLISHING.md**.
