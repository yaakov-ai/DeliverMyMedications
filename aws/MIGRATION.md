# Moving DeliverMyMedications to AWS — runbook

End state: CloudFront and AWS WAF at the edge, the website in S3, the API on Lambda inside a private VPC,
records in Aurora PostgreSQL encrypted with your own key, email through SES, texts through Pinpoint, audit
logs in S3 with Object Lock. Everything covered by the AWS BAA you accept in AWS Artifact. Cloudflare keeps
nothing and can be dropped entirely, or left as registrar only.

Allow **one working day** for steps 1–8 and a **30-minute cutover window** for step 9.

---

## Before you start

- AWS account with admin access, and `aws --version` ≥ 2.15 and `node --version` ≥ 20 on your machine.
- The repository checked out locally.
- Access to DNS for `delivermymedications.com`.
- Decide the region. `us-east-1` keeps the ACM certificate in the same place CloudFront needs it.

```bash
export AWS_REGION=us-east-1
aws sts get-caller-identity          # confirms you're in the right account
```

---

## Step 1 — Accept the BAA (5 minutes)

AWS Console → **Artifact → Agreements → AWS Business Associate Addendum → Accept**. Nothing you build before
this is covered, so do it first. Download the PDF and file it with `docs/vendors-and-baas.md`.

## Step 2 — Certificate (10 minutes, mostly waiting)

```bash
aws acm request-certificate --region us-east-1 \
  --domain-name delivermymedications.com \
  --subject-alternative-names www.delivermymedications.com \
  --validation-method DNS
aws acm describe-certificate --region us-east-1 --certificate-arn <arn> \
  --query "Certificate.DomainValidationOptions[].ResourceRecord"
```

Add the CNAME records it prints to your DNS. Wait for status `ISSUED`. Keep the ARN.

## Step 3 — Database stack (15 minutes)

```bash
aws cloudformation deploy \
  --template-file aws/database.yaml \
  --stack-name delivermymedications-db \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlertEmail=yaakov@safer.health
aws cloudformation describe-stacks --stack-name delivermymedications-db \
  --query "Stacks[0].Outputs" --output table
```

Confirm the SNS subscription email that arrives, or alarms go nowhere.

## Step 4 — Schema (10 minutes)

The database is private, so reach it through a one-off bastion with Session Manager:

```bash
# smallest instance in a private subnet, no key pair, no inbound ports
aws ec2 run-instances --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
  --instance-type t3.micro --subnet-id <SubnetA> --iam-instance-profile Name=AmazonSSMRoleForInstancesQuickSetup \
  --security-group-ids <AppSecurityGroup>
aws ssm start-session --target <instance-id>
# on the instance:
sudo dnf install -y postgresql15 git
SECRET=$(aws secretsmanager get-secret-value --secret-id delivermymedications/production/db --query SecretString --output text)
export PGPASSWORD=$(echo $SECRET | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
psql -h <ProxyEndpoint> -U dmm_admin -d delivermymedications -f schema-postgres.sql
```

Then terminate the instance. Check the tables exist:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1;
```

## Step 5 — Application stack (20 minutes)

```bash
aws cloudformation deploy \
  --template-file aws/app.yaml \
  --stack-name delivermymedications-app \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CertificateArn=<arn> LiveMode=false PaymentMode=test
```

`LiveMode=false` on purpose: the site comes up in demo mode so you can check the plumbing before real data
flows. CloudFront takes about 15 minutes to finish deploying.

## Step 6 — Secrets (10 minutes)

```bash
aws secretsmanager put-secret-value --secret-id delivermymedications/app --secret-string '{
  "GOOGLE_CLIENT_SECRET":"GOCSPX-…",
  "STRIPE_SECRET_KEY":"sk_live_…",
  "STRIPE_WEBHOOK_SECRET":"whsec_…",
  "SHIPSTATION_API_KEY":"…",
  "CARRIER_WEBHOOK_KEY":"<any long random string>"
}'
```

Rotate the Google client secret now if it has ever been pasted into email or chat.

## Step 7 — Email and texts (30 minutes, plus DNS propagation)

**Using Google Workspace (recommended if you already have a Workspace BAA).** Patient email then travels through
Google, which your existing agreement covers, and no third-party mail vendor is involved.

1. In the Google Admin console: **Apps → Google Workspace → Gmail → Routing → SMTP relay service → Configure**.
2. Name it "DeliverMyMedications app", allow senders **Only addresses in my domains**, require TLS, and under
   allowed senders add the **NatIpAddress** from the database stack outputs.
3. Deploy the app stack with `MailTransport=gmail MailAuth=ip`. Nothing else to configure, nothing to rotate.
4. If you'd rather authenticate than allow an address, create a `no-reply@delivermymedications.com` mailbox,
   turn on 2-step verification, create an app password, put it in the app secret as `MAIL_PASSWORD`, and deploy
   with `MailAuth=user MailUser=no-reply@delivermymedications.com`.

**Or using Amazon SES** (deploy with `MailTransport=ses`):

```bash
aws sesv2 create-email-identity --email-identity delivermymedications.com
aws sesv2 get-email-identity --email-identity delivermymedications.com \
  --query "DkimAttributes.Tokens"          # add the three CNAMEs to DNS
aws sesv2 put-account-details --production-access-enabled \
  --mail-type TRANSACTIONAL --website-url https://delivermymedications.com \
  --use-case-description "Order confirmations, prescription status updates and sign-in codes for our own pharmacy patients"
```

Production access review usually takes under 24 hours; until then SES only sends to verified addresses, which
is enough for testing. For texts, request a 10DLC number in **Pinpoint SMS → Phone numbers**, register the
brand and campaign, then set `SmsOriginationNumber` on the app stack. Texts stay off until you do.

## Step 8 — Deploy the code and test (30 minutes)

```bash
chmod +x aws/deploy.sh
./aws/deploy.sh all
```

Visit the CloudFront domain from the stack outputs (not your real domain yet) and check:

- the site loads and the catalog renders;
- `/api/health?setup=1` shows `liveMode:false` and no missing tables;
- `/api/config` responds.

Then switch the API to live mode and redeploy:

```bash
aws cloudformation deploy --template-file aws/app.yaml --stack-name delivermymedications-app \
  --capabilities CAPABILITY_IAM --parameter-overrides CertificateArn=<arn> LiveMode=true PaymentMode=test
```

Run the full flow against the CloudFront domain: create a patient account, place an order, approve it in the
provider portal, verify and ship it in the pharmacy board, request a refill, open the admin console.

## Step 9 — Cutover (30-minute window)

1. **Freeze**: tell staff to stop working in the portals. Put a banner on the Cloudflare site if you like
   (Admin → Settings → Site banner).
2. **Copy the data**:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=8f5eb7988a5f99f97bb3d2a4d83cbac7 CLOUDFLARE_API_TOKEN=<token> \
   node aws/migrate-d1-to-postgres.mjs --d1 88a32950-b42c-4a07-8d6a-0f906fcdfda4 \
     --pg "postgres://dmm_admin:<password>@<ProxyEndpoint>:5432/delivermymedications"
   ```
   It prints a row count per table and a D1-vs-Postgres comparison. Investigate any mismatch before continuing.
3. **Point DNS** at CloudFront: an ALIAS/CNAME for `delivermymedications.com` and `www` to the distribution
   domain. If you keep Cloudflare as DNS, set those records to **DNS only** (grey cloud) so traffic bypasses
   Cloudflare entirely — otherwise Cloudflare still sees PHI and still needs its own BAA.
4. **Watch**: `aws logs tail /aws/lambda/delivermymedications-api --follow`
5. **Smoke test on the real domain**: sign in as staff, open the pharmacy board, place a test order.
6. **Unfreeze** staff.

Keep the Cloudflare Worker deployed but with DNS pointed away for a week. If something is wrong, moving DNS
back is a two-minute rollback, and D1 still holds the data up to the freeze.

## Step 10 — Turn on the account-level controls (20 minutes)

```bash
aws cloudtrail create-trail --name dmm-trail --s3-bucket-name <AuditBucketName> --is-multi-region-trail
aws cloudtrail start-logging --name dmm-trail
aws guardduty create-detector --enable
aws securityhub enable-security-hub --enable-default-standards
aws backup start-backup-job --help     # or rely on the 35-day Aurora automated backups already configured
```

Then in `docs/`: sign the risk analysis, record the AWS BAA in the vendor tracker, and update the security
plan so it names AWS rather than Cloudflare.

---

## After the move

| Task | How |
| --- | --- |
| Deploy website changes | `./aws/deploy.sh site` |
| Deploy API changes | `./aws/deploy.sh api` |
| Watch logs | `aws logs tail /aws/lambda/delivermymedications-api --follow` |
| Query the database | Session Manager to a bastion, or RDS Query Editor |
| Add staff | `INSERT INTO staff …` as before |
| Switch to real cards | redeploy the app stack with `PaymentMode=stripe` |

**Running costs, roughly:** Aurora Serverless v2 $45–90, Lambda and CloudFront a few dollars at this volume,
NAT gateway $33, Secrets Manager $1, S3 and logs a few dollars. Call it **$100–150 a month**, against
Cloudflare Enterprise pricing for the same BAA coverage.

**What changed in the code:** nothing in the application logic. `aws/lambda/handler.mjs` translates API Gateway
events into the same `fetch(request, env, ctx)` the Worker used, `src/db/postgres.js` puts a D1-shaped API over
PostgreSQL, and `sendEmail`/`sendText` in `src/lib.js` now prefer SES and Pinpoint when they're wired up. The
Cloudflare version still works, so you can run both during the transition.
