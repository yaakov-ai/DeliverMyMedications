# Test deploy — the short version

This zip is ready to upload as-is. Your database id, Google client id and team settings are already in
`wrangler.jsonc`, and `src/generated/catalog.json` is prebuilt, so a deploy works even if the build step is skipped.

## 1. Upload

GitHub → your repo → **Add file → Upload files** → drag in **everything inside this folder** (not the folder
itself, and not the zip). Commit. Cloudflare deploys automatically.

There are no hidden files to worry about; anything that would normally start with a dot is in `extras/`.

## 2. Run the database files once

Cloudflare → **Storage & Databases → D1 → delivermymedications → Console**. Paste and run each in order,
skipping any you've already done:

| File | What it adds |
| --- | --- |
| `migrations/0001_init.sql` | Core tables |
| `migrations/0002_auth_admin.sql` | Patient logins, two-factor, settings |
| `migrations/0003_staff_login.sql` | Staff sessions for Google sign-in |
| `migrations/0004_roles.sql` | The Customer service role |

"Duplicate column name" means that part already ran — carry on with the next file.

Then add yourself, if you haven't:

```sql
INSERT OR REPLACE INTO staff (email, name, role, npi, states) VALUES
  ('yaakov@safer.health', 'Yaakov Mavashev', 'admin', NULL, NULL);
```

## 3. Check it

- `https://delivermymedications.com/api/health?setup=1` — shows what's configured, any missing tables, and the
  size of the page being served (`page.bytes` should be about 774,000 with `complete: true`).
- The site itself — browse, add to cart, check out (test mode: no card is charged).
- `/#/staff-signin` — needs `GOOGLE_CLIENT_SECRET` in the Worker's secrets.
- `/#/admin` — the console, once you're signed in as staff.

## What works without any secrets

Browsing, search suggestions, the finder's category tiles and questions, checkout in test mode, the patient
portal, and every staff portal once you can sign in. Prices, attestations, labs, the programs and the savings
maths all run locally.

## What needs a secret before it does anything

| Secret | Turns on |
| --- | --- |
| `GOOGLE_CLIENT_SECRET` | Staff sign-in |
| `RESEND_API_KEY` | Email: sign-in codes, order updates, lead follow-ups |
| `TWILIO_*` | Texts, including the cart reminder |
| `STRIPE_SECRET_KEY` + `PAYMENT_MODE=stripe` | Real card charges (test mode records orders without charging) |
| `ANTHROPIC_API_KEY` | The "what's going on?" assistant (falls back to keyword matching without it) |
| `SHIPSTATION_API_KEY` | Buying labels (tracking can be typed in by hand meanwhile) |

## If the page looks broken

Everything that styles this site is inside `public/index.html`, so a page that renders with text in a column,
no colours and no spacing almost always means the file didn't arrive whole, or the browser blocked something.

1. **Check what the site is actually serving.** Open `/api/health?setup=1` and look at `page`:
   `{"bytes": 774328, "complete": true}` is right. A much smaller number, or `"complete": false`, means the
   upload truncated — re-upload `public/index.html` on its own.
2. **Check where it landed.** In GitHub it must be at `public/index.html`, not at the root. The repo root should
   hold `wrangler.jsonc`, `package.json`, and the folders.
3. **Hard refresh** (Ctrl+Shift+R) or open a private window. Browsers hold the old page aggressively.
4. **Look at the browser console** (F12 → Console) and reload. Anything in red mentioning "Refused to load"
   or "Content Security Policy" means a header is blocking the stylesheet or fonts.
5. **Check `public/_headers`.** This zip ships a short version on purpose. If you later add the strict
   Content-Security-Policy from `extras/strict-csp.txt`, it must stay on one line — a wrapped line blocks
   Google Fonts and the page renders unstyled.

The site falls back to Georgia and a system sans if Google Fonts can't load, so it should still look tidy even
then — different, but not broken.

## Worth trying while you're testing

1. **"I'm not sure — let the provider choose"** on any prescription: pay $20, approve it in the provider portal, then buy the medication from the account with no second fee.
2. **The finder** at `/#/finder` — write a sentence in the box.
3. **Quattro** (`/#/p/combo-odt-as-needed`) — drag the dissolve slider, read the mechanism section.
4. **Admin → Settings** — video-visit rules, cart reminders, provider pay.
5. **Admin → Products** — change a price and watch the site and the charge both move.
