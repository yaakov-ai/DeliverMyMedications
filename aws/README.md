# HIPAA-ready database for DeliverMyMedications

The site currently stores patient and prescription records in Cloudflare D1. That's fine while there's no real
patient data in it. Before the first real patient, the database has to sit under a signed Business Associate
Agreement (BAA). This folder gives you two ways to get there, and everything needed for the AWS route.

## The decision

| | **Path A — stay on Cloudflare** | **Path B — database on AWS** |
|---|---|---|
| BAA | Enterprise contract only; talk to Cloudflare sales | Self-serve: accept it in AWS Artifact, minutes, no extra cost |
| D1 covered? | Yes — D1, Workers, Durable Objects, KV, R2 and Hyperdrive are listed as in-scope services, but only under an Enterprise BAA | Aurora, RDS, Secrets Manager, KMS, S3, CloudWatch are HIPAA-eligible under the standard BAA |
| Code changes | None | Swap the database layer (`src/db/postgres.js`, already written) |
| Cost | Cloudflare Enterprise pricing (negotiated, typically five figures a year) | ~$50–90/month for Aurora Serverless v2 at this volume, plus a few dollars for secrets and logs |
| Still need a Cloudflare BAA? | — | Yes if PHI passes through Workers. Keeping Workers means Cloudflare is still a business associate, so either get that BAA or move the API to AWS too (see "If you want Cloudflare out of scope") |

**Recommendation.** Ask Cloudflare sales what an Enterprise BAA costs first — if it's affordable, Path A is one
conversation and no engineering. If it isn't, Path B is the standard way small healthcare operators do this,
and the template here builds it in one command.

## What the template creates

`aws/database.yaml` (CloudFormation) builds:

- **A private VPC** with two subnets and no internet gateway on the data path.
- **Aurora Serverless v2 PostgreSQL 15**, encrypted with a **customer-managed KMS key**, never publicly
  reachable, 35 days of automated backups, deletion protection on.
- **RDS Proxy** with TLS required, so the application's short-lived connections pool cleanly.
- **Secrets Manager** credentials, generated at deploy and rotated every 60 days.
- **An S3 audit bucket with Object Lock in COMPLIANCE mode**, default retention 7 years, for archived audit
  logs. Nobody — including your own root account — can delete those objects before the retention expires.
- **CloudWatch alarms** for CPU and connection spikes, emailed to your alert address.

## Setting it up

```bash
# 1. Accept the BAA: AWS Console → Artifact → Agreements → AWS BAA → Accept
# 2. Deploy
aws cloudformation deploy \
  --template-file aws/database.yaml \
  --stack-name delivermymedications-db \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlertEmail=yaakov@safer.health

# 3. Read the outputs
aws cloudformation describe-stacks --stack-name delivermymedications-db \
  --query "Stacks[0].Outputs" --output table

# 4. Create the schema (run from a machine inside the VPC, or via Session Manager)
psql "$DATABASE_URL" -f aws/schema-postgres.sql
```

Then turn on the account-wide controls the HIPAA Security Rule expects:

```bash
aws cloudtrail create-trail --name dmm-trail --s3-bucket-name <AuditBucketName> --is-multi-region-trail
aws cloudtrail start-logging --name dmm-trail
aws guardduty create-detector --enable
aws securityhub enable-security-hub --enable-default-standards
```

## Connecting the application

The app only uses a small part of the database API, so `src/db/postgres.js` re-implements that surface on
PostgreSQL and rewrites the few SQLite-only expressions in the queries (`datetime('now','+30 days')`,
`json_extract(...)`, `?` placeholders). In `src/worker.js`:

```js
import { pgDatabase } from "./db/postgres.js";
// …inside fetch(), before routing:
if (env.HYPERDRIVE) env = { ...env, DB: pgDatabase(env.HYPERDRIVE.connectionString) };
```

and in `wrangler.jsonc`:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<created with: wrangler hyperdrive create dmm --connection-string=...>" }]
```

Hyperdrive holds the connection string as a secret, pools connections at the edge, and keeps TLS end to end.
Point it at the **proxy endpoint**, not the cluster endpoint.

**Porting notes**

- JSON columns are `JSONB`, so `row.data` comes back as an object rather than a string. Either drop the
  `JSON.parse(...)` calls, use the `jsonAsText` helper in the adapter, or keep those columns as `TEXT`.
- The version-guard trick (`json('version conflict')`) becomes a division by zero, which also aborts the
  transaction — the concurrency protection behaves identically.
- Run the full end-to-end tests against the new database before switching production over.

## If you want Cloudflare out of scope entirely

PHI passes through the Worker, so Cloudflare is a business associate even if the data rests on AWS. To avoid
that, move the API to AWS and leave Cloudflare doing DNS and static assets only:

1. Put `public/` behind **CloudFront + AWS WAF** (S3 origin), with caching disabled on `/api/*`.
2. Run `src/` on **Lambda** behind **API Gateway** (or ECS Fargate), in the private subnets, reaching the
   database through RDS Proxy.
3. Keep Cognito or the current Google sign-in for staff, and Secrets Manager for keys.
4. Point DNS at CloudFront. Cloudflare then never sees an authenticated request.

That's roughly two to three days of work for an agency familiar with AWS, and the layered pattern matches the
AWS healthcare reference architecture: edge filtering, private networking, customer-managed keys, immutable
audit storage, continuous monitoring.

## What the database alone does not give you

Encryption and a BAA are the technical half. The rest is in `docs/`: the security plan, the risk analysis, the
breach procedure, training records, and BAAs with every other vendor that touches PHI (email, texts, shipping,
payments). A perfectly configured database in an organisation with no risk analysis on file still fails an audit.
