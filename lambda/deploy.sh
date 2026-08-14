#!/usr/bin/env bash
#
# Deploy a function from this folder to AWS Lambda.
#
#   ./lambda/deploy.sh                  # deploys prompt-logs
#   ./lambda/deploy.sh prompt-logs      # same, explicit
#
# What it does, in order:
#   1. Syntax-checks the handler.
#   2. Builds a clean staging dir (handler + package.json + `npm install --omit=dev`)
#      and prunes TypeScript declarations, which are dead weight at runtime and
#      are what pushes @aws-sdk paths past Windows' 260-char MAX_PATH limit.
#   3. Zips it.
#   4. Publishes the CURRENT code as a numbered version first, so there is always
#      something to roll back to, then updates $LATEST.
#   5. Smoke-tests the deployment with a CORS preflight — that exercises module
#      load (i.e. every import resolves) without writing a single log event or
#      metric datapoint.
#
# Dependencies are BUNDLED rather than relying on the SDK the managed runtime
# happens to ship, so the deployed artifact is reproducible.
#
# Environment overrides:
#   FUNCTION_NAME   Target Lambda. Default: per the SOURCE→FUNCTION map below.
#   AWS_PROFILE     Passed through to the AWS CLI as usual.
#   AWS_REGION      Passed through to the AWS CLI as usual.
#   BUILD_ROOT      Where to stage the build. Default: ~/.claude-lambda-build
#                   Keep it SHORT on Windows — a long root plus the nested
#                   @aws-sdk tree overruns MAX_PATH and the zip step fails.
#   SKIP_SMOKE_TEST 1 to skip step 5.
#   KEEP_BUILD      1 to leave the staging dir in place for inspection.

set -euo pipefail

SOURCE_NAME="${1:-prompt-logs}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$SOURCE_NAME"

# Source folder → deployed function name.
case "$SOURCE_NAME" in
  prompt-logs) DEFAULT_FUNCTION="claude-cmd-ui-prompt-logger" ;;
  *)           DEFAULT_FUNCTION="" ;;
esac
FUNCTION_NAME="${FUNCTION_NAME:-$DEFAULT_FUNCTION}"

BUILD_ROOT="${BUILD_ROOT:-$HOME/.claude-lambda-build}"
BUILD_DIR="$BUILD_ROOT/$SOURCE_NAME"
ZIP_PATH="$BUILD_ROOT/$SOURCE_NAME.zip"

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# node, npm and the AWS CLI are all native Windows binaries under Git Bash, and
# none of them understand a POSIX "/c/Users/..." path. Translate before handing a
# path to any of them.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

[ -d "$SOURCE_DIR" ] || die "no such function source: $SOURCE_DIR"
[ -f "$SOURCE_DIR/index.mjs" ] || die "$SOURCE_DIR/index.mjs not found"
[ -n "$FUNCTION_NAME" ] || die "no function name for '$SOURCE_NAME' — set FUNCTION_NAME=..."
command -v aws >/dev/null || die "aws CLI not found on PATH"
command -v npm >/dev/null || die "npm not found on PATH"
command -v node >/dev/null || die "node not found on PATH"

echo "source:   $SOURCE_DIR"
echo "function: $FUNCTION_NAME"
echo "region:   $(aws configure get region 2>/dev/null || echo "${AWS_REGION:-<default>}")"

# --- 1. syntax check ---------------------------------------------------------
step "Checking syntax"
node --check "$SOURCE_DIR/index.mjs"
echo "ok"

# --- 2. build ----------------------------------------------------------------
step "Building deployment package"
rm -rf "$BUILD_DIR" "$ZIP_PATH"
mkdir -p "$BUILD_DIR"
cp "$SOURCE_DIR/index.mjs" "$BUILD_DIR/"
[ -f "$SOURCE_DIR/package.json" ] && cp "$SOURCE_DIR/package.json" "$BUILD_DIR/"

# Run node from inside the build dir throughout: on Git Bash a POSIX "/c/..."
# path is meaningless to the Windows node binary, so relative paths only.
if [ -f "$BUILD_DIR/package.json" ] && (cd "$BUILD_DIR" && node -e "process.exit(Object.keys(require('./package.json').dependencies||{}).length?0:1)"); then
  (cd "$BUILD_DIR" && npm install --omit=dev --no-package-lock --no-audit --no-fund --silent)
  # .d.ts files are never loaded at runtime and carry the longest paths.
  find "$BUILD_DIR/node_modules" -type d -name dist-types -prune -exec rm -rf {} + 2>/dev/null || true
  find "$BUILD_DIR/node_modules" -name '*.d.ts' -delete 2>/dev/null || true
else
  echo "no runtime dependencies declared — shipping the handler alone"
fi

# Prove every import resolves against what we are about to ship, before we ship it.
(cd "$BUILD_DIR" && node -e "import('./index.mjs').then(m => { if (typeof m.handler !== 'function') { console.error('index.mjs does not export a handler function'); process.exit(1); } }).catch(e => { console.error('handler failed to load:', e.message); process.exit(1); })")
echo "handler loads cleanly"

# --- 3. zip ------------------------------------------------------------------
step "Creating zip"
if command -v zip >/dev/null; then
  (cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" .)
elif command -v powershell >/dev/null; then
  powershell -NoProfile -Command "
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory('$(native_path "$BUILD_DIR")', '$(native_path "$ZIP_PATH")', [System.IO.Compression.CompressionLevel]::Optimal, \$false)" \
    || die "zip failed — if the error mentions a long path, set BUILD_ROOT to a shorter directory"
else
  die "need either 'zip' or PowerShell to create the deployment package"
fi
[ -f "$ZIP_PATH" ] || die "zip was not created at $ZIP_PATH"
echo "$(du -h "$ZIP_PATH" | cut -f1)  $ZIP_PATH"

# --- 4. deploy ---------------------------------------------------------------
step "Publishing rollback version of the currently deployed code"
ROLLBACK=$(aws lambda publish-version \
  --function-name "$FUNCTION_NAME" \
  --description "pre-deploy rollback point" \
  --query Version --output text)
echo "rollback version: $ROLLBACK"
echo "  to roll back, download that version's code and re-upload it:"
echo "    aws lambda get-function --function-name $FUNCTION_NAME:$ROLLBACK --query Code.Location --output text"

step "Uploading new code"
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$(native_path "$ZIP_PATH")" \
  --query '{CodeSize:CodeSize,Sha256:CodeSha256,Status:LastUpdateStatus}' \
  --output table
aws lambda wait function-updated --function-name "$FUNCTION_NAME"
echo "update complete"

# --- 5. smoke test -----------------------------------------------------------
if [ "${SKIP_SMOKE_TEST:-0}" != "1" ]; then
  step "Smoke-testing (CORS preflight — writes no data)"
  PAYLOAD='{"requestContext":{"http":{"method":"OPTIONS","path":"/"}},"headers":{}}'
  OUT_NAME="$SOURCE_NAME.smoke.json"
  OUT="$BUILD_ROOT/$OUT_NAME"
  aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --payload "$PAYLOAD" \
    --query 'FunctionError' --output text "$(native_path "$OUT")" > /dev/null
  STATUS=$(cd "$BUILD_ROOT" && node -e "try{console.log(JSON.parse(require('fs').readFileSync('$OUT_NAME','utf8')).statusCode)}catch(e){console.log('unparseable')}")
  # 204 = preflight answered. 401 = the function has an API_KEY set and the
  # auth check runs ahead of the OPTIONS branch — also a healthy handler, which
  # is all this step claims to prove. Anything else (or an unparseable body)
  # means the module failed to load or the handler threw.
  case "$STATUS" in
    204) echo "ok — handler responded 204" ;;
    401) echo "ok — handler responded 401 (API_KEY is set; auth runs before the OPTIONS branch)" ;;
    *)
      echo "SMOKE TEST FAILED: expected 204 or 401, got $STATUS" >&2
      echo "response: $(cat "$OUT")" >&2
      echo "roll back: aws lambda get-function --function-name $FUNCTION_NAME:$ROLLBACK --query Code.Location --output text" >&2
      echo "           then download that zip and re-upload it with update-function-code" >&2
      exit 1
      ;;
  esac
fi

# --- IAM reminder ------------------------------------------------------------
# prompt-logs publishes cost/usage metrics with cloudwatch:PutMetricData, which
# is NOT part of the basic Lambda execution role. Warn rather than mutate IAM:
# granting permissions is a bigger decision than shipping code.
if [ "$SOURCE_NAME" = "prompt-logs" ]; then
  ROLE_ARN=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --query Role --output text)
  ROLE_NAME="${ROLE_ARN##*/}"
  if ! aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames' --output text 2>/dev/null | grep -q PutMetricData; then
    echo
    echo "WARNING: role $ROLE_NAME has no inline *PutMetricData* policy."
    echo "  Cost/usage metrics will fail with AccessDenied until it is granted:"
    echo "    aws iam put-role-policy --role-name $ROLE_NAME \\"
    echo "      --policy-name ClaudeCmdUiPutMetricData --policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"cloudwatch:PutMetricData\",\"Resource\":\"*\",\"Condition\":{\"StringEquals\":{\"cloudwatch:namespace\":\"ClaudeCmdUI\"}}}]}'"
  fi
fi

[ "${KEEP_BUILD:-0}" = "1" ] || rm -rf "$BUILD_DIR"

step "Deployed $SOURCE_NAME to $FUNCTION_NAME"
