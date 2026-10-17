#!/usr/bin/env bash
#
# Deploy Ledgerline to AWS Fargate.
#
#   scripts/deploy.sh                 provision (if needed), build, push, roll out
#   scripts/deploy.sh --plan          show what Terraform would change, then stop
#   scripts/deploy.sh --skip-build    roll out the image already in ECR
#   scripts/deploy.sh --skip-infra    build and push, then force a new deployment
#
# Reads ACME_EMAIL from the environment, falling back to the .env file.
# Everything else is configured in infra/terraform (see example.tfvars).
# Application accounts are created through the app's signup page.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

DO_BUILD=true
DO_INFRA=true
PLAN_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) DO_BUILD=false ;;
    --skip-infra) DO_INFRA=false ;;
    --plan)       PLAN_ONLY=true ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)            echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed.${2:+ $2}"
}

tf() { terraform -chdir="$TF_DIR" "$@"; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

step "Checking prerequisites"

need terraform "Install: brew install hashicorp/tap/terraform"
need docker "Install Docker Desktop, or see https://docs.docker.com/get-docker/"
need aws "Install: brew install awscli"

docker buildx version >/dev/null 2>&1 || fail "docker buildx is required (ships with current Docker Desktop)."
docker info >/dev/null 2>&1 || fail "The Docker daemon is not running."

if ! ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  fail "AWS credentials are not configured. Run 'aws configure' (or export AWS_PROFILE) and retry."
fi
info "AWS account: $ACCOUNT_ID"


# Let's Encrypt requires a contact address. Fall back to ACME_EMAIL from the
# environment or .env so the common case needs no tfvars file.
if [ -z "${TF_VAR_acme_email:-}" ]; then
  if [ -n "${ACME_EMAIL:-}" ]; then
    TF_VAR_acme_email="$ACME_EMAIL"
  elif [ -f "$ROOT_DIR/.env" ]; then
    TF_VAR_acme_email="$(
      grep -E '^[[:space:]]*ACME_EMAIL=' "$ROOT_DIR/.env" |
        tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
    )"
  fi
fi
export TF_VAR_acme_email="${TF_VAR_acme_email:-}"

# ---------------------------------------------------------------------------
# Terraform init, and the ECR repository the image needs to exist first
# ---------------------------------------------------------------------------

step "Initializing Terraform"
tf init -input=false >/dev/null
info "Working directory ready: $TF_DIR"

if [ "$PLAN_ONLY" = true ]; then
  step "Planning"
  tf plan -input=false
  exit 0
fi

if [ "$DO_INFRA" = true ]; then
  step "Ensuring the container registry exists"
  # Targeted apply so there is somewhere to push before the service that
  # references the image is created.
  tf apply -input=false -auto-approve -target=aws_ecr_repository.app >/dev/null
fi

# A targeted apply does not necessarily materialise every output, so fall back
# to the AWS CLI's own configuration and a direct lookup.
REGION="$(tf output -raw aws_region 2>/dev/null || true)"
if [ -z "$REGION" ]; then
  REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-west-1)}}"
fi

PROJECT="$(
  grep -hE '^[[:space:]]*project_name[[:space:]]*=' "$TF_DIR"/*.tfvars 2>/dev/null |
    tail -1 | cut -d'"' -f2
)"
PROJECT="${PROJECT:-ledgerline}"

REPO_URL="$(tf output -raw ecr_repository_url 2>/dev/null || true)"
if [ -z "$REPO_URL" ]; then
  REPO_URL="$(aws ecr describe-repositories --repository-names "$PROJECT" \
    --region "$REGION" --query 'repositories[0].repositoryUri' --output text 2>/dev/null || true)"
fi
[ -n "$REPO_URL" ] || fail "Could not determine the ECR repository URL. Run 'terraform -chdir=$TF_DIR apply' once and retry."
info "Region:   $REGION"
info "Registry: $REPO_URL"

# ---------------------------------------------------------------------------
# Build and push
# ---------------------------------------------------------------------------

IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"

if [ "$DO_BUILD" = true ]; then
  step "Building and pushing the image ($IMAGE_TAG)"

  ARCH="$(tf output -raw cpu_architecture 2>/dev/null || true)"
  case "${ARCH:-ARM64}" in
    X86_64) PLATFORM="linux/amd64" ;;
    *)      PLATFORM="linux/arm64" ;;
  esac
  info "Platform: $PLATFORM"

  aws ecr get-login-password --region "$REGION" |
    docker login --username AWS --password-stdin "${REPO_URL%%/*}" >/dev/null
  info "Authenticated to ECR"

  docker buildx build \
    --platform "$PLATFORM" \
    --tag "$REPO_URL:$IMAGE_TAG" \
    --tag "$REPO_URL:latest" \
    --push \
    "$ROOT_DIR"
  info "Pushed $REPO_URL:$IMAGE_TAG"
else
  IMAGE_TAG="$(
    tf output -raw image_tag 2>/dev/null ||
      grep -E '^image_tag' "$TF_DIR/image.auto.tfvars" 2>/dev/null | cut -d'"' -f2 ||
      echo latest
  )"
  step "Skipping build — deploying tag $IMAGE_TAG"
fi

# Persist the tag so a later bare `terraform apply` keeps running this image
# instead of silently falling back to the default.
printf 'image_tag = "%s"\n' "$IMAGE_TAG" > "$TF_DIR/image.auto.tfvars"

# ---------------------------------------------------------------------------
# Apply, and wait for the rollout
# ---------------------------------------------------------------------------

if [ "$DO_INFRA" = true ]; then
  step "Applying infrastructure"
  if ! tf state list 2>/dev/null | grep -q aws_lb.app; then
    info "First run with a custom domain waits for ACM to validate the"
    info "certificate through Route 53, which usually takes a few minutes."
  fi
  tf apply -input=false -auto-approve
else
  step "Forcing a new deployment"
  aws ecs update-service \
    --cluster "$(tf output -raw cluster_name)" \
    --service "$(tf output -raw service_name)" \
    --force-new-deployment \
    --region "$REGION" >/dev/null
fi

CLUSTER="$(tf output -raw cluster_name)"
SERVICE="$(tf output -raw service_name)"

step "Waiting for the service to stabilize"
info "This usually takes 2-4 minutes (image pull, database migration, health check)."
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"; then
  printf '\n'
  info "The service did not reach a steady state. Recent events:"
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].events[0:5].message' --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/      /'
  info "Logs: aws logs tail $(tf output -raw log_group) --region $REGION --since 10m"
  fail "Rollout did not complete."
fi

# ---------------------------------------------------------------------------
# Report where the app is
# ---------------------------------------------------------------------------

step "Deployed"

APP_URL="$(tf output -raw app_url)"
case "$APP_URL" in
  http*://*task-public-ip*)
    TASK_ARN="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
      --desired-status RUNNING --region "$REGION" --query 'taskArns[0]' --output text)"
    ENI_ID="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
      --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)"
    PUBLIC_IP="$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI_ID" --region "$REGION" \
      --query 'NetworkInterfaces[0].Association.PublicIp' --output text)"
    printf '    App:  \033[1mhttp://%s:3000\033[0m\n' "$PUBLIC_IP"
    info ""
    info "That address belongs to the running task and changes whenever the task"
    info "is replaced. Set enable_alb = true for a stable DNS name over HTTPS."
    ;;
  *)
    printf '    App:  \033[1m%s\033[0m\n' "$APP_URL"
    if [ "$(tf output -raw tls_mode 2>/dev/null || true)" = "letsencrypt" ]; then
      info ""
      info "The task answers on a fresh public IP and a Lambda has just pointed"
      info "the record at it; allow up to a minute for DNS, plus a little longer"
      info "on the very first deploy while Let's Encrypt issues the certificate."
      info "Watch it with: scripts/status.sh --logs"
    fi
    ;;
esac

info "Logs: aws logs tail $(tf output -raw log_group) --region $REGION --follow"
info "Image tag deployed: $IMAGE_TAG"
printf '\n'
