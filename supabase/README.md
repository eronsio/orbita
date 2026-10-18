# Turning on accounts + cloud sync

Orbita works without any of this (contacts live in each person's browser). These steps add **sign-up / sign-in and
saving each tester's map in the cloud**, so it follows them across devices. Until the two values in step 5 are filled in,
the app shows no account UI at all and makes no network calls.

## 1. Create a NEW Supabase project
supabase.com -> New project. Name it `orbita`. **Do not reuse the student-portal project**: testers' contacts must never
share a database with student data. Save the database password somewhere safe (the app never needs it).

## 2. Create the table
SQL Editor -> New query -> paste all of [`orbita_setup.sql`](orbita_setup.sql) -> Run. It creates one table with
row-level security, so a signed-in user can only ever read or write **their own row**.

## 3. Sign-up settings (Authentication -> Providers -> Email)
- Keep **Email** enabled.
- **Confirm email:** for a small prototype turn it **off**, so testers are signed in the moment they sign up. If you leave it
  on, testers must click an emailed link first; Supabase's built-in mailer only sends a couple of emails per hour, so
  more than a few testers will hit that limit unless you add your own SMTP (Authentication -> SMTP Settings).
- Authentication -> Sign In / Providers -> set **Minimum password length** to 8.

## 4. Allow the reset-password link to come back to the app (Authentication -> URL Configuration)
- **Site URL:** `https://orbita.aaronsiebertsio.workers.dev`
- **Redirect URLs:** add the same address.

## 5. Paste the two public values into the app
Project Settings -> API: copy the **Project URL** and the **`anon` `public`** key, then fill them in near the top of
the script in `index.html`:

```js
const CLOUD = { url: 'https://YOUR-PROJECT.supabase.co', anonKey: 'eyJ...' };
```

The anon key is **meant to be public** (it ends up in the page source); row-level security is what protects the data.
**Never** paste the `service_role` key anywhere in this repo.

Commit and push; Cloudflare redeploys and a "Sign in" button appears in the header.

## 6. Check it
Sign up two throwaway accounts in two browsers and confirm each sees only its own contacts. Users can be viewed or
removed under Authentication -> Users (deleting a user also deletes their saved contacts).

## Notes
- Contacts are stored as one JSON document per user (`orbita_data`), capped at about 8 MB. Two devices that edit at the
  same time are reconciled with a three-way merge (see `threeWayMerge` in `index.html`).
- This is a prototype: whoever runs the Supabase project can technically read what testers sync. The dialog says so.
- Free Supabase projects pause after about a week of no use; open the dashboard to resume one.
- To test locally without a project: `node tests/mock-supabase.js`, then open
  `http://localhost:8766/?supabase=http://localhost:54321&key=test` (that override only works on localhost). Using
  `127.0.0.1` instead of `localhost` gives you a second, separate "device".
