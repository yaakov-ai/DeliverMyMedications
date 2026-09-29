#!/usr/bin/env bash
# Builds and deploys the application to AWS. Run from the repository root:
#   ./aws/deploy.sh            deploy everything
#   ./aws/deploy.sh site       website files only (fast)
#   ./aws/deploy.sh api        Lambda code only
set -euo pipefail

PROJECT=${PROJECT:-delivermymedications}
DB_STACK=${DB_STACK:-$PROJECT-db}
APP_STACK=${APP_STACK:-$PROJECT-app}
REGION=${AWS_REGION:-us-east-1}
WHAT=${1:-all}

out() { aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

BUCKET=$(out "$APP_STACK" SiteBucketName)
DIST=$(out "$APP_STACK" DistributionId)
FN=$(out "$APP_STACK" ApiFunctionName)

build_api() {
  echo "→ building API bundle"
  rm -rf .aws-build && mkdir -p .aws-build
  node scripts/build.mjs                                  # regenerates src/generated/catalog.json
  cp -r src aws package.json .aws-build/
  (cd .aws-build && npm install --omit=dev --silent postgres @aws-sdk/client-secrets-manager \
      @aws-sdk/client-sesv2 @aws-sdk/client-pinpoint-sms-voice-v2 nodemailer >/dev/null)
  (cd .aws-build && zip -qr ../api.zip .)
  echo "→ uploading"
  aws s3 cp api.zip "s3://$BUCKET/lambda/api.zip" --region "$REGION"
  aws lambda update-function-code --function-name "$FN" --s3-bucket "$BUCKET" --s3-key lambda/api.zip \
    --region "$REGION" --publish >/dev/null
  aws lambda wait function-updated --function-name "$FN" --region "$REGION"
  rm -rf .aws-build api.zip
  echo "✓ API deployed"
}

build_site() {
  echo "→ uploading website"
  aws s3 cp public/index.html "s3://$BUCKET/index.html" --region "$REGION" \
    --cache-control "public,max-age=60" --content-type "text/html; charset=utf-8"
  aws s3 sync public/ "s3://$BUCKET/" --region "$REGION" --exclude "index.html" --exclude "_headers" --delete
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null
  echo "✓ website deployed"
}

case "$WHAT" in
  site) build_site ;;
  api)  build_api ;;
  all)  build_api; build_site ;;
  *) echo "usage: $0 [all|site|api]"; exit 1 ;;
esac
