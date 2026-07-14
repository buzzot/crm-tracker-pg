# Deploying to Hostinger via GitHub

This app is now a git repo (first commit made locally). Workflow: keep developing locally, push to GitHub when you want to share or deploy, and let Hostinger auto-deploy from the connected branch.

## 1. Push the repo to GitHub

From your machine, in the `crm-tracker` folder:

```bash
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin master
```

(Create the empty repo on GitHub first — don't initialize it with a README, since this repo already has one.)

Going forward, your day-to-day loop is just:

```bash
git add -A
git commit -m "..."
git push
```

## 2. Requirements on Hostinger's side

Node.js Web Apps Hosting (with backend/server support for Express.js) requires a **Business Web Hosting** or **Cloud** plan (Startup/Professional/Enterprise). Supported Node versions: 18.x, 20.x, 22.x, 24.x — this app's `package.json` now declares `"engines": { "node": ">=18.0.0" }`.

## 3. Connect the GitHub repo in hPanel

1. hPanel → **Websites** → **Add Website** → **Node.js Apps**.
2. Choose **Import Git Repository** → **Connect GitHub** → authorize Hostinger's GitHub App.
3. Select your repo and the branch (`master`).
4. Build settings — since this is a plain Express app with no frontend build step:
   - Framework: select **Other** if not auto-detected.
   - **Entry file**: `server.js`
   - **Output directory**: leave blank (no build artifacts to publish — this isn't a frontend bundle)
   - Build command: not needed, but if Hostinger requires one, `npm install` is sufficient (no compile step).
5. Click **Deploy**.

Once connected, every push to `master` triggers an automatic redeploy. You can also hit **Redeploy** manually from the dashboard.

## 4. Environment variables

Set these in hPanel → your Node.js app → **Environment Variables** (mirrors `.env.example` — never commit the real `.env`):

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_OAUTH_CLIENT_ID`
- `AIRTABLE_OAUTH_CLIENT_SECRET`
- `APP_BASE_URL` — set to your real Hostinger domain (e.g. `https://yourdomain.com`); the Airtable OAuth redirect URI must match `APP_BASE_URL + /auth/airtable/callback`
- `ADMIN_EMAIL`
- `SESSION_SECRET` — generate a real random value, e.g. `openssl rand -hex 32`. The app refuses to boot in production without this.
- `PORT` — Hostinger sets/manages this for you; you generally don't need to set it manually, the app already reads `process.env.PORT`.
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `NODE_ENV=production` — enables the secure-cookie/trust-proxy logic already in `server.js`.

## 5. One thing to be aware of: sessions

This app stores login sessions on disk (`session-file-store`, in the `.sessions/` folder next to `server.js`) rather than in a database. On Hostinger, each redeploy can replace the app directory, which would log everyone out. That's a minor inconvenience, not a data-loss risk — all real CRM data lives in Airtable, not in sessions. If frequent logouts after deploys become annoying, the fix later would be swapping the session store for something that survives redeploys (e.g. a small hosted Redis/SQLite), but it's not required to ship.

## 6. Custom domain / SSL

Once the Node.js app is live, attach your domain and issue a free SSL certificate from the same website's hPanel settings, then update `APP_BASE_URL` (and the Airtable OAuth redirect URI) to match.

---

Sources: [How to add a Node.js Web App in Hostinger](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/), [How to deploy a Git repository in Hostinger](https://www.hostinger.com/support/1583302-how-to-deploy-a-git-repository-in-hostinger/)
