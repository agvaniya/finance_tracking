#!/usr/bin/env bash
#
# Show where the deployed app is reachable and how it is doing.
#
#   scripts/status.sh            service state, task address, recent events
#   scripts/status.sh --logs     also tail the last 15 minutes of logs

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"
SHOW_LOGS=false
[ "${1:-}" = "--logs" ] && SHOW_LOGS=true

tf() { terraform -chdir="$TF_DIR" "$@"; }
info() { printf '    %s\n' "$1"; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }

if ! tf output -raw cluster_name >/dev/null 2>&1; then
  printf 'No deployment found. Run scripts/deploy.sh first.\n' >&2
  exit 1
fi

REGION="$(tf output -raw aws_region)"
CLUSTER="$(tf output -raw cluster_name)"
SERVICE="$(tf output -raw service_name)"

step "Service"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}' \
  --output table

step "Address"
APP_URL="$(tf output -raw app_url)"
TLS_MODE="$(tf output -raw tls_mode 2>/dev/null || echo none)"

task_public_ip() {
  TASK_ARN="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
    --desired-status RUNNING --region "$REGION" --query 'taskArns[0]' --output text 2>/dev/null)"
  [ "$TASK_ARN" = "None" ] || [ -z "$TASK_ARN" ] && return 1
  ENI_ID="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
    --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)"
  aws ec2 describe-network-interfaces --network-interface-ids "$ENI_ID" --region "$REGION" \
    --query 'NetworkInterfaces[0].Association.PublicIp' --output text
}

case "$APP_URL" in
  http*://*task-public-ip*)
    if IP="$(task_public_ip)"; then
      printf '    \033[1mhttp://%s:3000\033[0m\n' "$IP"
    else
      info "No running task right now."
    fi
    ;;
  *)
    printf '    \033[1m%s\033[0m\n' "$APP_URL"
    ;;
esac

# In letsencrypt mode the A record is maintained by a Lambda, so a stale record
# is the thing most likely to be wrong. Show both sides.
if [ "$TLS_MODE" = "letsencrypt" ]; then
  DOMAIN="$(tf output -raw domain_name)"
  RESOLVED="$(dig +short A "$DOMAIN" 2>/dev/null | tail -1)"
  if IP="$(task_public_ip)"; then
    info "Task public IP: ${IP}"
  else
    IP=""
    info "Task public IP: (no running task)"
  fi
  info "${DOMAIN} resolves to: ${RESOLVED:-(no answer)}"
  if [ -n "$IP" ] && [ -n "$RESOLVED" ] && [ "$IP" != "$RESOLVED" ]; then
    info "DNS has not caught up yet — the record carries a 60s TTL."
    info "If it stays wrong, check: aws logs tail $(tf output -raw dns_updater_log_group) --region $REGION --since 15m"
  fi
fi

step "Recent service events"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].events[0:5].message' --output text | tr '\t' '\n' | sed 's/^/    /'

if [ "$SHOW_LOGS" = true ]; then
  step "Logs (last 15 minutes)"
  aws logs tail "$(tf output -raw log_group)" --region "$REGION" --since 15m 2>/dev/null ||
    info "Install AWS CLI v2 for 'aws logs tail', or view the log group in the console."
fi

printf '\n'
