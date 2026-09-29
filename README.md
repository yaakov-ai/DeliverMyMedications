# DeliverMyMedications.com

Online prescription ordering, asynchronous telehealth review, and pharmacy fulfillment. It runs on **Cloudflare Workers** (website and API) with a **D1** database, deployed from **GitHub**.

```
public/index.html        The whole website and the patient, provider, and pharmacy portals
public/_headers          Security headers for the site
src/worker.js            API: checkout, sign-in, portal saves, payments, shipping, webhooks, scheduled jobs
src/rules.js             Who may change what (roles, ownership, protected fields)
src/pricing.js           Server-side prices (read from public/index.html at build time)
src/auth.js              Staff sign-in (Cloudflare Access) and patient sessions
src/lib.js               Database, email, text, Stripe, and time helpers
migrations/0001_init.sql Database tables
scripts/build.mjs        Copies the catalog and prices out of index.html for the server
scripts/add-staff.sql    Adds staff who can use the portals
tools/                   Price-grid scripts (see tools/README.md)
test/smoke.mjs           Pricing checks (npm test)
wrangler.jsonc           Cloudflare settings
```

The site runs in two modes:

- **Demo** (`LIVE_MODE` = `"false"`, the default). The site works exactly like the prototype, and each visitor's data stays in their own browser. Use this for your first deploy.
- **Live** (`LIVE_MODE` = `"true"`). Data is saved in D1, staff sign in through Cloudflare Access, and patients sign in by email link. Payments run through the server.
  - With `PAYMENT_MODE` = `"test"`, orders are recorded without charging a card, so you can test everything first.

---

## 1. Put the code on GitHub

1. Create a new **private** repository on GitHub, for example `delivermymedications`.
2. Unzip the download on your computer. Open the `delivermymedications` folder, select **everything inside it**, and drag it onto **Add file → Upload files**. Then click **Commit changes**.
   - Upload the files inside the folder, not the zip file itself.
   - This folder has no hidden files, because GitHub's upload page rejects them. `wrangler.jsonc` and `package.json` must end up at the top level of the repository.
3. Optional: add the hidden files from the `extras` folder. None of them are needed for Cloudflare to deploy.
   - **`.gitignore`** (only matters if you later use `git` on your computer): **Add file → Create new file**, name it `.gitignore`, and paste in the contents of `extras/gitignore.txt`.
   - **GitHub Actions deploy** (only if you choose that method): create a new file named `.github/workflows/deploy.yml` and paste in `extras/deploy-workflow.yml`.
   - **Local development settings** (on your computer only, never on GitHub): copy `extras/dev.vars.example.txt` to a file named `.dev.vars`.

## 2. Create the database

1. In the Cloudflare dashboard, open **Storage & Databases → D1 → Create database**. Name it `delivermymedications`.
2. Copy the **Database ID** and paste it into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Commit the change on GitHub.
3. Open the database's **Console** tab. Paste the whole contents of `migrations/0001_init.sql` and run it, then do the same with `migrations/0002_auth_admin.sql`.
4. Edit the names and emails in `scripts/add-staff.sql`, then run it in the same console. Everyone who uses the provider or pharmacy portal needs a row, with one of these roles:
   - `provider`: reviews and signs. Use the exact prescribing name, the NPI, and the license states.
   - `pharmacist`: enters Rx, verifies, packs, and ships.
   - `technician`: can do everything a pharmacist can except the pharmacist verification.
   - `support`: customer service. Sees order status, patient messages and prescription links; answers tickets, resends links, and corrects a shipping address before an order ships. Cannot verify, ship, prescribe, or open the admin console.
   - `admin`: can do everything.

## 3. Deploy from GitHub

1. In the dashboard, open **Workers & Pages → Create → Import a repository**. Connect GitHub and choose your repository.
2. Use these settings:
   - **Project name:** `delivermymedications` (it must match `name` in `wrangler.jsonc`).
   - **Build command:** leave empty. Wrangler runs `scripts/build.mjs` itself.
   - **Deploy command:** `npx wrangler deploy`.
3. Click **Deploy**. From now on, every push to `main` redeploys automatically.
4. Add your domain. Open the Worker, then **Settings → Domains & Routes → Add → Custom domain**, and enter `delivermymedications.com` (add `www` too if you want it).

Your site is now online in demo mode.

> **Prefer GitHub Actions?** The workflow in `extras/deploy-workflow.yml` deploys the site and runs database migrations. Add it as `.github/workflows/deploy.yml`.
> 1. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
> 2. Add a repository variable `DEPLOY_WITH_ACTIONS` set to `true`.
> 3. Don't also connect the repository in the dashboard. Use one method, not both.

## 4. Turn on live mode

There are two kinds of settings:

- **Plain settings** live in `wrangler.jsonc` under `"vars"`. Change them in that file and commit, because each deploy replaces dashboard values with the file's values.
- **Secrets** go in the dashboard: open the Worker, then **Settings → Variables and Secrets → Add → Secret**. Secrets stay in place across deploys.

### a. Staff sign-in — pick one

**Option 1: Sign in with Google on your own site (default).** No Cloudflare Access needed.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project, then **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
2. Add an **Authorized redirect URI**: `https://delivermymedications.com/auth/google/callback`
3. Under **OAuth consent screen**, set the app name and support email. If your staff use Google Workspace, choose **Internal** so only your domain can sign in.
4. Copy the client ID into `wrangler.jsonc` as `GOOGLE_CLIENT_ID`, and add the client secret as the Worker secret `GOOGLE_CLIENT_SECRET`.
5. Optional: set `GOOGLE_HD` to your Workspace domain (for example `safer.health`) so the account picker only offers work accounts.
6. Leave `AUTH_MODE` as `"google"` and `STAFF_MFA` as `"on"`.

Staff then go to `/#/staff-signin`, press **Continue with Google**, and — because `STAFF_MFA` is on — set up an authenticator app the first time and enter a 6-digit code on every sign-in. They also get eight recovery codes. Google verifies the password and any Google 2-step; your site checks the email is in the `staff` table. Sessions last one day. An admin can reset someone's two-factor from **Admin → Staff → Reset 2FA**.

**Option 2: Cloudflare Access.** Set `AUTH_MODE` to `"access"` and follow the steps below. Use `"both"` during a switchover.

#### Cloudflare Access setup

1. Open **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Add two public hostnames for your domain, one with the path `staff/*` and one with `api/staff/*`.
3. Add a policy that allows your staff emails. Turn on a one-time PIN or connect Google or Microsoft, and require MFA.
4. Copy the application's **AUD tag**. Then set these in `wrangler.jsonc`:
   - `ACCESS_TEAM_DOMAIN`: your team domain, for example `saferpharmacy.cloudflareaccess.com`.
   - `ACCESS_AUD`: the AUD tag.

Staff sign in at `https://delivermymedications.com/staff/login`, which opens the pharmacy board. The provider portal is at `/#/provider`.

### b. Email (and optional texts)

1. Create a [Resend](https://resend.com) account, verify your domain, and create an API key.
2. Add the secret `RESEND_API_KEY`.
3. In `wrangler.jsonc`, set `EMAIL_FROM` to an address on the verified domain.
4. Optional, for Rx-ready links and refill reminders by text: add the Twilio secrets `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` (a number like `+15555550123`).

Alerts go to `ALERT_EMAIL`. These include the 20-hour and 24-hour warnings and the daily auto-ship count.

### c. Go live with test payments

1. In `wrangler.jsonc`, make these changes and commit:
   - Set `LIVE_MODE` to `"true"`.
   - Keep `PAYMENT_MODE` as `"test"`.
   - Set `PUBLIC_URL` to your site address.
2. Test the full flow:
   1. Place an order.
   2. Approve it in the provider portal.
   3. Verify and ship it on the pharmacy board.
   4. Request a refill from My account.
   5. Enter an Rx for a test patient and complete the texted link.

### d. Real payments (after Stripe approves your pharmacy account)

1. Add the secret `STRIPE_SECRET_KEY` (`sk_live_...`).
2. In `wrangler.jsonc`, set `STRIPE_PUBLISHABLE_KEY` (`pk_live_...`) and change `PAYMENT_MODE` to `"stripe"`.
3. In Stripe, add a webhook pointing to `https://delivermymedications.com/api/stripe/webhook`. Subscribe it to `payment_intent.payment_failed`, `charge.refunded`, and `charge.dispute.created`.
4. Add the webhook's signing secret as the secret `STRIPE_WEBHOOK_SECRET`.

How charges work:

- **Checkout:** the card is authorized for the full amount and saved for refills. The charge is captured when the provider signs, and only for approved items. Anything declined is never charged.
- **Refills and auto-ship:** the saved card is charged when the refill is placed.
- **Pharmacy-entered Rx (memberships):** charged at purchase.
- **Refunds:** issued automatically when the pharmacy cancels an item, a prescriber denies months, or our provider declines a continuation.

### e. ShipStation

1. Add the secret `SHIPSTATION_API_KEY`.
2. In `wrangler.jsonc`, fill in `SS_WAREHOUSE_ID`, `SS_SERVICE_OVERNIGHT`, `SS_SERVICE_2DAY`, and `SS_SERVICE_GROUND` from your ShipStation account.
3. For delivery updates, add a secret `CARRIER_WEBHOOK_KEY` (any long random text). Then point ShipStation's tracking webhook to `https://delivermymedications.com/api/carrier/webhook?key=YOUR_KEY`.

Until ShipStation is connected, staff enter tracking numbers by hand.

## Who signs in, and how

| Who | How they sign in | Where |
|---|---|---|
| Patients | Email code, then an authenticator app or a text code | `/#/account` |
| Providers, pharmacists, technicians | Cloudflare Access (your SSO with MFA) | `/staff/login` |
| Admins | Their staff sign-in, plus the admin role in the staff table | `/#/admin` |
| Owner (super admin) | Same sign-in; set by `OWNER_EMAIL` | Everything |

**Patients** create their own account: name, date of birth, mobile, email and address, then they choose a second factor and save eight one-time recovery codes. Sessions are cookie-based and can be ended from any device with "Sign out everywhere." Five wrong codes locks the account for 15 minutes. A saved card is optional and lives at Stripe; you only ever see the brand and last four digits.

**Providers and pharmacy staff** apply at `/#/apply`. Providers give their credentials, NPI, state licenses with numbers and expiry dates, malpractice carrier and policy, and practice details. Pharmacy staff give their role, license number and verification initials. Nobody gets access until an admin approves them in the console, which creates their sign-in and emails them. A provider's license states control which patients they may approve; the server refuses anything outside them.

**The owner** is `OWNER_EMAIL` in `wrangler.jsonc`, currently `yaakov@safer.health`. That account is the super admin: it can do anything any role can do, including approving prescriptions in any state; it can't be demoted or disabled from the console; and if its staff row is ever deleted, it's recreated the next time it signs in, so you can't be locked out of your own system. To hand ownership over, change `OWNER_EMAIL` and redeploy.

**The admin console** (`/#/admin`) has:
- **Dashboard:** patients, staff, applications waiting, open tickets, money captured and refunded.
- **Approvals:** review and approve or deny applications, with the denial reason emailed.
- **Staff:** add, update, or disable staff and set provider NPI and license states.
- **Patients:** search accounts, reset two-factor, unlock, sign out, or disable an account.
- **Products:** change a price, description or picture, hide something, or add a product. Changes appear on the site immediately and can be undone.
- **Tickets:** read and answer patient messages; replies are emailed.
- **Email:** send a one-off message.
- **Activity:** the audit trail of every action.
- **Settings:** support phone, site banner, and cutoff note.

Only an admin can reach the console, and every action there is written to the audit log.

## Legal pages and compliance documents

**On the site** (`/#/legal/...`, linked in the footer and from checkout): Telehealth Informed Consent, Privacy Policy, HIPAA Notice of Privacy Practices, Terms of Use, Shipping and Refunds, Compounded Medication Disclosure, and Text Message Terms. These are drafts written around how this business actually works — asynchronous visits, cash pay, compounding, 43 states. **Have healthcare counsel review them before launch.**

**Per-medication attestations.** Every prescription product asks the patient to confirm what they must *not* have for that class of medicine — for example no nitrates before ED medication, no personal or family history of medullary thyroid cancer before a GLP-1, no prior angioedema before a blood pressure medicine — and shows the common side effects, the serious ones, and when to stop and get help. Every prescription item in the catalog is covered; the wording lives in `attStatements` and `RISKS` in `public/index.html`. The full text the patient saw is stored with the order and quoted in the provider's note.

**In `docs/`:** a HIPAA security plan mapped to what the platform does, a started risk analysis with the gaps listed, a breach response plan with the notification deadlines, workforce training content with a sign-off sheet, a vendor and BAA tracker, an asynchronous telehealth compliance checklist (including the state questions to confirm), and pharmacy operations requirements.

## How the four clinical rules work

**1. Only a provider licensed in the patient's state can prescribe.** A provider's states come from their `staff` row. The queue shows only patients in those states, with a line saying how many requests are waiting for someone licensed elsewhere. The server refuses an approval outside a provider's states even if the browser is tampered with. Admins see everything.

**2. Patients hear about every step.** Email and text go out when the provider decides, when the pharmacy starts preparing, when it's checked by the pharmacist, when it's packed, when it ships (with the tracking number), when it's out for delivery, and when it's delivered. Held or cancelled shipments and provider questions are covered too. Messages never name the medication; the detail sits behind the patient's login, where each order also shows a full status history.

**3. Providers are paid by the patient, through the platform.** The patient pays $20 per prescription reviewed. The platform keeps a service fee (**Admin → Provider pay**, default $5) and the provider receives the rest ($15). A declined prescription is refunded in full, so nothing is collected and nothing is owed. When a note is signed, the server works out the split and records a payout row — the browser can't change it.

Providers add their own bank details through **Getting paid** in their portal, which opens Stripe's onboarding pages. Account and routing numbers go to Stripe, never to this database, and the form refuses anything that looks like an account number. The pharmacy sees only whether someone is set up and what they've earned. In **Admin → Provider pay** you can **Send to their bank** (a Stripe transfer) or **Mark paid** for checks and payroll, and download a CSV. Providers who prefer a check or payroll record that preference instead.

**Turning on bank payments:** in the Stripe dashboard, enable **Connect** and Express accounts, then keep enough balance to cover transfers. Without Connect, everything else still works and you pay providers outside the platform.

**4. Safer Pharmacy is the default.** On each approval the provider picks "Safer Pharmacy (our pharmacy)" — preselected — or "Patient's own pharmacy," which needs the pharmacy name and phone or fax. Sent-out prescriptions never enter your fulfillment board: the patient is charged only the review fee, the medication charge is refunded, and their portal shows where it went and to call that pharmacy.

## Updating prices or products

- **Where prices live:** the prices and catalog are in `public/index.html`.
- **Per-strength prices:** use the workbook and `tools/apply_price_grid.py` (see `tools/README.md`), then commit the updated `public/index.html`.
- **Other settings:** the provider fee, shipping fees, excluded states, and plan discounts are near the top of the script in `index.html`.

The server reads the same prices on the next deploy, so the site and the charges always match.

## Local development

```
npm install
cp extras/dev.vars.example.txt .dev.vars
npx wrangler d1 execute delivermymedications --local --file migrations/0001_init.sql
npx wrangler d1 execute delivermymedications --local --file scripts/add-staff.sql
npm run dev        # http://localhost:8787: local database, test payments, signed in as DEV_STAFF_EMAIL
npm test           # pricing checks
```

## Scheduled jobs

These run automatically once the site is live.

- **Every 15 minutes:**
  - 24-hour clock alerts: an email at 20 hours, and a logged miss at 24 hours.
  - Patient link reminders at 24 and 72 hours.
  - Link expiry after 7 days.
- **Daily at 10:00 UTC** (6 AM EDT / 5 AM EST):
  - A text to patients whose auto-refill ships in 3 days.
  - An email to the pharmacy with how many auto-ships are due.

Due auto-ships are charged and added to the list when the pharmacy board is opened that morning.

## Before you launch

- **Business associate agreements (BAAs):** the database stores protected health information. Cloudflare lists D1 and Workers as in-scope services, but only signs BAAs with Enterprise customers — see `aws/README.md` for that decision and for a ready-to-deploy AWS Aurora alternative under the self-serve AWS BAA. Use email and text providers that sign one too, or leave texts off.
- **Payments and certification:** get Stripe approval for pharmacy and telehealth (or use a high-risk processor), and get LegitScript certification.
- **Licensing:**
  - You need pharmacy licenses for every state you ship to.
  - Providers must be licensed in each patient's state. List each provider's states in their `staff` row; the server blocks approvals outside them.
- **Two-factor for staff:** require MFA in your Cloudflare Access policy. Patients already must use it.
- **Identity checks:** verify a patient by phone before resetting their two-factor, and verify licenses and run background checks before approving a provider.
- **Demo content:** replace the demo provider details. Have counsel review the attestation text, legal pages, and ESA state list.
- **Security:**
  - Require MFA in Cloudflare Access.
  - Add a Cloudflare WAF rate-limiting rule for `/api/auth/*` and `/api/links/*`.

## Known limits

- **Data volume:** the portals load up to 5,000 recent records of each type. Add paging before you reach that volume.
- **Auto-ship timing:** auto-ships are processed when the pharmacy board is opened, not at a fixed time overnight.
- **Locations:** the platform supports one pharmacy location and one fulfillment board.
