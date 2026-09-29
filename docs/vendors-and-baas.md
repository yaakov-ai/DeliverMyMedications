# Vendors and Business Associate Agreements

A BAA is required before any vendor creates, receives, maintains or transmits PHI for you.

| Vendor | What they handle | Agreement needed | Status |
|---|---|---|---|
| Cloudflare (Workers, D1, Access) | All clinical records, hosting | BAA — confirm availability on your plan | ☐ |
| Stripe | Names, emails, payments | Stripe's terms; no clinical data sent | ☐ |
| Resend (email) | Names, emails, order numbers | BAA, or switch to a HIPAA-eligible provider (Paubox, LuxSci) | ☐ |
| Twilio (text) | Mobile numbers, order numbers | BAA (available on their HIPAA-eligible products) | ☐ |
| ShipStation and carriers | Names, addresses | Carriers are conduits; ShipStation needs review | ☐ |
| Pharmacy software vendor | Full prescription records | BAA | ☐ |
| Fax service | Prescriptions | BAA | ☐ |
| Accountant, counsel, consultants | Whatever they see | BAA where applicable | ☐ |

**Keep out of scope where you can.** The platform is built so messages to patients never name a medication, which
keeps the content flowing through email and text providers minimal.

For each signed BAA record: vendor, signer, date, renewal date, and where the executed copy is kept.
