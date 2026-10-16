# Secrets live in SSM Parameter Store rather than Secrets Manager: standard
# parameters are free, where Secrets Manager bills ~$0.40 per secret per month.
# ECS reads them at task start and injects them as environment variables, so
# they never appear in the task definition or in CloudWatch.

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

locals {
  database_url = format(
    "postgresql://%s:%s@%s:%s/%s?schema=public&sslmode=require",
    aws_db_instance.main.username,
    random_password.db.result,
    aws_db_instance.main.address,
    aws_db_instance.main.port,
    aws_db_instance.main.db_name,
  )
}

resource "aws_ssm_parameter" "database_url" {
  name        = "/${var.project_name}/DATABASE_URL"
  description = "Prisma connection string for the Ledgerline database"
  type        = "SecureString"
  value       = local.database_url
}

resource "aws_ssm_parameter" "app_password" {
  name        = "/${var.project_name}/APP_PASSWORD"
  description = "Ledgerline login password"
  type        = "SecureString"
  value       = var.app_password
}

resource "aws_ssm_parameter" "session_secret" {
  name        = "/${var.project_name}/SESSION_SECRET"
  description = "Key used to sign Ledgerline session cookies"
  type        = "SecureString"
  value       = random_password.session_secret.result
}
