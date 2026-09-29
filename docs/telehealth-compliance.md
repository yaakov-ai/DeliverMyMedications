# Asynchronous Telehealth Compliance

## How the visit is structured
1. The patient completes medication-specific attestations: what they must not have, their pregnancy status, other medicines, and an acknowledgment of the risks of that class of medicine.
2. They give consent to asynchronous telehealth, separately from the terms of use.
3. A provider **licensed in the patient's state** reviews the attestations, any note from the patient, and the medication history in the record. The platform only shows them patients in their licensed states and refuses approvals outside them.
4. The provider approves, asks a question, declines, or sends the prescription to the patient's own pharmacy.
5. An encounter note is generated, reviewed, and signed. Signing locks it with a hash.
6. The patient is charged only for what is approved. The review fee is refunded when a provider declines.

## What keeps this defensible
- The full attestation text the patient saw is stored with the order, not just a checkbox.
- The note records what was asked, what was attested, what was decided, and why.
- Notes can't be edited after signing; corrections are added as new entries.
- Every action carries an actor, timestamp and IP in the audit log.
- Providers are paid per review whether they approve or decline, so pay doesn't depend on prescribing. Declined reviews are refunded to the patient and no fee is kept.

## Rules to confirm with counsel for each state you serve
- **Is an asynchronous (store-and-forward) visit enough to establish a provider-patient relationship?** Most states allow it; a few require live audio-video for a first visit or for specific drugs.
- **Questionnaire-only rules.** Some states prohibit prescribing from a static questionnaire alone; your attestations plus provider review and follow-up questions are designed for this, but confirm.
- **Telehealth registration.** A few states require a separate telemedicine licence or registration.
- **Follow-up duty.** Several states require a way for the patient to reach the prescriber; the platform's question-and-reply covers it.
- **Compounded GLP-1s.** Rules and FDA positions have shifted; confirm current status before advertising them.
- **ESA letters.** California, and by some readings Florida, Iowa, Montana, Utah, Oklahoma and Illinois, require an established relationship or a live evaluation. These states are blocked in the platform.
- **Corporate practice of medicine.** Where it applies, the professional entity (a PC or PLLC) must employ the providers, with a management services agreement between it and the pharmacy or platform company.
- **Fee splitting and kickbacks.** Confirm the platform's service fee is a fair-market-value technology and administrative charge, not a share of clinical revenue, and that it doesn't vary with whether a prescription is written.

## Advertising
- Don't claim a prescription is guaranteed.
- Don't compare a compounded product to a brand as equivalent.
- Keep price comparisons factual, dated and documented.
- Don't use patient testimonials about specific results without the required disclosures.
