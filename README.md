# Samyou CRM & Project Tracker

A lightweight CRM + project tracker that reads/writes directly to your existing
**Samyou USA** Airtable base (Company, Contacts, Deals, Activities, Projects,
Project Activities). Built with Node.js + Express + EJS, styled with Bootstrap 5.

## Features

- **Sign in with Airtable** — users log in with their real Airtable email
  and password (Airtable's own login screen verifies the password; this app
  never sees it). Access level is derived live, every login, from each
  person's actual permission level on the Samyou USA base: Owner → Admin,
  Create/Edit → Manager, Comment/Read → Sales (Sales only sees records they
  own, via the existing "Owner" fields on Company/Deals/Activities/Project
  Activities). `buzzardontree@gmail.com` is always Admin. Admins get an
  `/admin` page listing everyone who shows up as an owner anywhere in the
  base — no separate "users" table needed.
- Dashboard: company count, open pipeline value, recent activity
- Sales pipeline board grouped by deal stage, by company — drag a deal card
  to a new stage (or use its dropdown) and it updates Airtable instantly,
  no page reload
- Company directory with search
- Company detail page: linked contacts, deals, projects, and activities.
  Click any activity to see its full details (date, type, result, notes) in
  a popup, fetched live from Airtable
- Activities and Project Activities can be linked to a Project record
  (real Airtable relation), and to an email from your Inbox over IMAP — in
  an activity's popup, click "Find related emails" to search your Inbox for
  messages near that activity's date with a similar subject, then "Link" the
  right one. The subject/date/Message-ID get written back to Airtable.
  Once linked, click "View" next to the linked email to open a live preview
  of its Subject and Body, fetched fresh over IMAP on each open — the body
  is never saved to Airtable or stored anywhere in the app.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   - `AIRTABLE_TOKEN` — create a Personal Access Token at
     [airtable.com/create/tokens](https://airtable.com/create/tokens) with
     scopes `data.records:read`, `data.records:write`, `schema.bases:read`,
     scoped to the **Samyou USA** base.
   - `AIRTABLE_BASE_ID` — already filled in (`appcE3X4eDSNXwOQl`).
   - `AIRTABLE_OAUTH_CLIENT_ID` / `AIRTABLE_OAUTH_CLIENT_SECRET` — register an
     OAuth integration yourself at
     [airtable.com/create/oauth](https://airtable.com/create/oauth) (this is
     an interactive step only you can do, since it's tied to your Airtable
     account):
     - Redirect URI: `<APP_BASE_URL>/auth/airtable/callback` (e.g.
       `http://localhost:3000/auth/airtable/callback`).
     - Scopes: `data.records:read`, `data.records:write`,
       `schema.bases:read`, `user.email:read`.
     - Copy the generated Client ID and Client Secret into `.env`.
   - `APP_BASE_URL` — where this app is reachable (default
     `http://localhost:3000`); must match the OAuth redirect URI's origin.
   - `ADMIN_EMAIL` — already set to `buzzardontree@gmail.com`; this account
     always gets the Admin role.
   - `SESSION_SECRET` — any long random string.
   - `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASSWORD` — optional,
     only needed for the "Find related emails" button. Pre-filled for
     `imap.qiye.aliyun.com:993` / `marsel@samyouusa.com` — just set
     `IMAP_PASSWORD` to your real mailbox password (or an app password, if
     your provider requires one for IMAP). Leave `IMAP_PASSWORD` unset and
     that feature simply shows an error when used; nothing else breaks.

4. Run it:

   ```bash
   npm start
   ```

   Then open <http://localhost:3000> and click "Sign in with Airtable".

## Roles & access

There is no separate "users" table — roles come straight from Airtable:

- **Admin** (`buzzardontree@gmail.com` only, for now): full access, plus
  the `/admin` page listing everyone found as an "Owner" collaborator
  anywhere in the base.
- **Manager**: anyone whose Airtable permission level on this base is
  Create or Edit. Sees all records, same as Admin minus the admin page.
- **Sales**: anyone whose permission level is Comment or Read. Only sees
  companies/deals/activities/project activities where they're listed in
  the **Owner** field.
- Anyone with no access to the base at all (permission level "none") is
  refused login.

To change someone's role, change their collaborator permission on the
Samyou USA base in Airtable itself — it takes effect on their next login.

## Notes on the Airtable integration

- The app reads/writes via the Airtable REST API directly (no SDK
  dependency), addressing fields by **field ID** (see `config/schema.js`) so
  renaming a column label in Airtable won't break anything.
- Currently only the pipeline's deal **Stage** is editable from the app.
  Everything else is read-only here — keep adding/editing companies,
  contacts, deals, and activities in Airtable itself, and this app reflects
  changes immediately (each page load fetches fresh data, no caching).
- If you add genuinely new fields/tables in Airtable that you want surfaced
  here, add their field IDs to `config/schema.js` and extend
  `services/crm.js`.

If you already had `node_modules` installed before this feature was added,
run `npm install` again to pick up the new `imapflow`/`mailparser`
dependencies.

## Project structure

```
server.js               App entrypoint, middleware, route wiring
config/schema.js        Airtable table/field ID map
services/airtableClient.js   Low-level Airtable REST calls (app-level PAT)
services/airtableAuth.js     "Sign in with Airtable" OAuth2 + PKCE
services/crm.js         Domain logic: companies, deals, pipeline, activities, roles
services/email.js       IMAP read-only email linking/preview
middleware/auth.js      Session login guard (requireAuth, requireAdmin)
routes/                 auth, dashboard, pipeline, companies, admin, json api
views/                  EJS templates (Bootstrap 5)
public/                 CSS + client-side JS (drag/drop, modals, search)
```
