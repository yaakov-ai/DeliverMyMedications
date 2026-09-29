# HIPAA Security Plan

Covered entity: Safer Pharmacy, Inc. (pharmacy) · Platform: DeliverMyMedications.com
Security Officer: ______________ · Privacy Officer: ______________ · Effective: ______________

## 1. Administrative safeguards

| Requirement | What we do | Evidence |
|---|---|---|
| Risk analysis (§164.308(a)(1)(ii)(A)) | Documented in `risk-analysis.md`, reviewed at least yearly and after major changes | Signed copy |
| Risk management | Findings tracked to closure with an owner and date | Risk register |
| Sanction policy | Written discipline for privacy violations, applied consistently | HR file |
| Activity review | Audit log reviewed weekly for unusual access; alerts on failed sign-ins | Admin → Activity |
| Security Officer | Named above, responsible for these policies | Appointment letter |
| Workforce clearance and termination | Access granted by role; access removed the same day someone leaves | Admin → Staff |
| Access authorization | Roles: provider, pharmacist, technician, admin. Least privilege enforced in code | `src/rules.js` |
| Training | At hire and yearly; see `workforce-training.md` | Sign-off sheet |
| Contingency plan | Daily database backup, tested restore, documented downtime procedure | Backup log |
| Business associates | Signed BAAs before any vendor touches PHI; see `vendors-and-baas.md` | Executed BAAs |

## 2. Physical safeguards

- Pharmacy access limited to licensed staff; visitors logged.
- Screens positioned away from public view; automatic lock after 5 minutes.
- Devices encrypted; no PHI on personal devices or removable media.
- Paper (faxed prescriptions) stored locked and shredded when no longer required.

## 3. Technical safeguards — what the platform already does

| Requirement | Implementation |
|---|---|
| Unique user identification | Every person has their own account; no shared logins |
| Authentication | Patients: emailed code plus authenticator app or text. Staff: Google (or Cloudflare Access) plus authenticator app |
| Automatic logoff | Staff sessions expire after 1 day; patients after 30 days; both revocable instantly |
| Access control | Server checks role, ownership and licensed states on every write (`src/rules.js`) |
| Audit controls | Every read of portal data and every change is written to `audit_log` with actor, action, record and IP |
| Integrity | Version checks on every record; encounter notes locked with a SHA-256 hash at signing |
| Transmission security | TLS everywhere; messages to patients never name a medication |
| Encryption at rest | Cloudflare D1 storage encryption |
| Emergency access | Admin role can reach records when a provider or pharmacist is unavailable; use is logged |

## 4. Policies staff must follow

1. Look at a record only when you need it for your job.
2. Never share an account or a second-factor device.
3. Report a suspected breach to the Security Officer within 24 hours.
4. Don't email or text health details outside the platform.
5. Verify identity before discussing a record by phone (name, date of birth, address).

## 5. Review

This plan is reviewed yearly and whenever the platform, vendors, or applicable law change materially.

Signed: ______________________  Date: ____________
