// Runs the same application code on AWS Lambda that ran on Cloudflare Workers.
//
// The Worker exports `fetch(request, env, ctx)` and `scheduled(event, env, ctx)`. Node 20 already provides
// fetch, Request, Response and crypto.subtle, so the only work here is translating API Gateway events into
// a Request, supplying `env` from environment variables and Secrets Manager, and providing `ctx.waitUntil`.
//
// CloudFront sends only /api/*, /auth/*, /staff/* and /admin/* here; everything else is served from S3.

import worker from "../../src/worker.js";
import { pgDatabase } from "../../src/db/postgres.js";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { sesMailer, pinpointSms } from "./aws-messaging.mjs";
import { gmailRelay } from "./gmail-relay.mjs";

const sm = new SecretsManagerClient({});
let cached = null;                       // survives between invocations on a warm container

async function secretJson(arn) {
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(out.SecretString);
}

async function buildEnv() {
  if (cached) return cached;
  const db = await secretJson(process.env.DB_SECRET_ARN);
  const app = process.env.APP_SECRET_ARN ? await secretJson(process.env.APP_SECRET_ARN) : {};
  const host = process.env.DB_PROXY_ENDPOINT;
  const url = `postgres://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${host}:5432/${process.env.DB_NAME || "delivermymedications"}`;
  cached = {
    ...process.env,          // plain settings: LIVE_MODE, PUBLIC_URL, OWNER_EMAIL, AUTH_MODE, …
    ...app,                  // secrets: GOOGLE_CLIENT_SECRET, STRIPE_SECRET_KEY, RESEND_API_KEY, …
    DB: pgDatabase(url, { max: 2 }),
    // MAIL_TRANSPORT=gmail routes patient email through Google Workspace; anything else uses Amazon SES.
    SES: process.env.MAIL_TRANSPORT === "gmail"
      ? gmailRelay({ from: process.env.EMAIL_FROM, auth: process.env.MAIL_AUTH || "ip", user: process.env.MAIL_USER || app.MAIL_USER, pass: app.MAIL_PASSWORD })
      : sesMailer(process.env.EMAIL_FROM || "no-reply@delivermymedications.com"),
    SMS: process.env.SMS_ORIGINATION_NUMBER ? pinpointSms(process.env.SMS_ORIGINATION_NUMBER) : undefined,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }
  };
  return cached;
}

function toRequest(event) {
  const h = event.headers || {};
  const proto = h["x-forwarded-proto"] || "https";
  const host = h["x-forwarded-host"] || h.host || new URL(process.env.PUBLIC_URL).host;
  const path = event.rawPath || event.requestContext?.http?.path || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const method = event.requestContext?.http?.method || "GET";
  const body = event.body == null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  // CloudFront gives the caller's IP here; the app reads CF-Connecting-IP.
  const headers = new Headers(h);
  if (!headers.get("CF-Connecting-IP")) headers.set("CF-Connecting-IP", event.requestContext?.http?.sourceIp || "unknown");
  if (Array.isArray(event.cookies) && event.cookies.length) headers.set("Cookie", event.cookies.join("; "));
  return new Request(`${proto}://${host}${path}${qs}`, { method, headers, body });
}

async function toResult(res) {
  const headers = {};
  const cookies = [];
  res.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") cookies.push(v); else headers[k] = v; });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = (headers["content-type"] || "").match(/json|text|xml|javascript/);
  return {
    statusCode: res.status,
    headers,
    cookies,
    isBase64Encoded: !text,
    body: text ? buf.toString("utf8") : buf.toString("base64")
  };
}

export async function handler(event) {
  const env = await buildEnv();
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p), passThroughOnException() {} };
  try {
    // EventBridge schedules arrive without an HTTP request.
    if (event?.source === "aws.events" || event?.cron) {
      await worker.scheduled({ cron: event.cron || event.detail?.cron || "*/15 * * * *" }, env, ctx);
      await Promise.allSettled(pending);
      return { ok: true };
    }
    const res = await worker.fetch(toRequest(event), env, ctx);
    const out = await toResult(res);
    await Promise.allSettled(pending);       // finish background work before the container freezes
    return out;
  } catch (e) {
    console.error("handler", e);
    await Promise.allSettled(pending);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Something went wrong. Please try again." }) };
  }
}
