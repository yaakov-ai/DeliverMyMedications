# Security Risk Analysis

Required by 45 CFR §164.308(a)(1)(ii)(A). Complete the blanks with your own judgment, then sign and date it.
Repeat at least yearly and after any material change.

## 1. Where protected health information lives

| Location | What's there | Who can reach it |
|---|---|---|
| Cloudflare D1 database | Orders, prescriptions, notes, fills, messages, accounts | Worker code; admins through the console |
| Cloudflare Workers logs | Request paths and error messages (no PHI by design) | Cloudflare account admins |
| Stripe | Names, emails, card data, amounts | Finance staff, Stripe |
| Resend (email) | Names, emails, order numbers | Support staff, Resend |
| Twilio (text), if enabled | Mobile numbers, order numbers | Support staff, Twilio |
| ShipStation and carriers | Names, addresses, package contents category | Pharmacy staff, carrier |
| Pharmacy system of record | Full prescription records | Pharmacy staff |
| Paper faxes | Prescriptions and renewals | Pharmacy staff |

## 2. Threats considered

| Threat | Likelihood | Impact | Controls in place | Residual risk / decision |
|---|---|---|---|---|
| Stolen staff credentials | Medium | High | Google or Access sign-in, authenticator app, 1-day sessions, audit log | |
| Patient account takeover | Medium | High | Emailed code plus second factor, lockout after 5 failures, session revocation | |
| Insider snooping | Low | High | Role limits, full audit log, weekly review, sanction policy | |
| Vendor breach | Low | High | BAAs, minimum data shared, no card data stored | |
| Lost or stolen device | Medium | Medium | Encryption, auto-lock, remote sign-out | |
| Ransomware on pharmacy PCs | Medium | High | Backups, separate systems, ______________ | |
| Mis-delivered shipment | Medium | Medium | Address confirmation at checkout, tracking, signature for ______________ | |
| PHI in email or text | Medium | Medium | Messages never name medications; staff policy | |
| Database deletion or corruption | Low | High | Versioned records, daily backup, tested restore | |

## 3. Gaps to close

- [ ] Sign a BAA with Cloudflare (needed before real patient data).
- [ ] Sign BAAs with Resend and Twilio, or switch to HIPAA-eligible alternatives.
- [ ] Decide and document backup frequency and who tests restores.
- [ ] Decide how long audit logs are kept (6 years is the HIPAA documentation standard).
- [ ] Name the Security and Privacy Officers in writing.
- [ ] Add device encryption and screen-lock checks to the staff onboarding list.

Completed by: ______________  Title: ______________  Date: ____________
