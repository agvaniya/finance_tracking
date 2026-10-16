#!/usr/bin/env bash
#
# Tear down everything this project created in AWS, so it stops costing money.
# The database is deleted without a final snapshot — back up anything you want
# to keep before running this.
#
#   scripts/destroy.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

tf() { terraform -chdir="$TF_DIR" "$@"; }

if ! tf output -raw cluster_name >/dev/null 2>&1; then
  printf 'Nothing to destroy — no Terraform state found in %s\n' "$TF_DIR"
  exit 0
fi

cat <<'WARNING'

This permanently deletes the Ledgerline stack:

  - the RDS database and all recorded balances, payments and history
    (skip_final_snapshot is set, so there will be no snapshot to restore)
  - the ECS service, cluster and container images
  - the VPC, security groups and any load balancer

WARNING

printf 'Type "destroy" to confirm: '
read -r CONFIRM
[ "$CONFIRM" = "destroy" ] || { printf 'Cancelled.\n'; exit 1; }

# Terraform still wants a value for the required variable while destroying.
export TF_VAR_app_password="${TF_VAR_app_password:-unused-during-destroy}"

printf '\nTo dump the database first, cancel now and run:\n'
# shellcheck disable=SC2016  # printing a command for the user to copy, not running it
printf '  pg_dump "$(terraform -chdir=%s output -raw database_url 2>/dev/null)" > backup.sql\n' "$TF_DIR"
printf '  (requires db_public_access_cidrs to include your IP)\n\n'

tf destroy -input=false -auto-approve

rm -f "$TF_DIR/image.auto.tfvars"
printf '\nDestroyed. Nothing from this stack should appear on your next bill.\n'
