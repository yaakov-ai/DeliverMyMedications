// Sends patient email through Google Workspace's SMTP relay, which is covered by your Workspace BAA.
//
// Two ways to authorize, set by MAIL_AUTH:
//   "ip"   — Workspace allows the NAT gateway's fixed IP address. Nothing to authenticate, nothing to rotate.
//   "user" — a dedicated Workspace mailbox with 2-step verification and an app password, kept in Secrets Manager.
//
// Either way the message leaves from your own domain, so SPF, DKIM and DMARC already line up and the mail
// is far less likely to land in spam than mail from a new sending service.

import nodemailer from "nodemailer";

export function gmailRelay({ from, auth, user, pass }) {
  const transport = nodemailer.createTransport({
    host: "smtp-relay.gmail.com",
    port: 587,
    secure: false,          // STARTTLS: the connection is upgraded to TLS before anything is sent
    requireTLS: true,
    auth: auth === "user" && user ? { user, pass } : undefined,
    pool: false,
    connectionTimeout: 8000
  });

  return {
    async send(to, subject, text) {
      try {
        await transport.sendMail({ from, to, subject: String(subject).slice(0, 180), text });
        return true;
      } catch (e) {
        // Never log the message body: it can name a patient.
        console.error("gmail-relay", e.code || e.name, e.message);
        return false;
      }
    }
  };
}
