variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-west-1"
}

variable "project_name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "ledgerline"
}

variable "image_tag" {
  description = "Container image tag to run. deploy.sh writes this into image.auto.tfvars."
  type        = string
  default     = "latest"
}

# ---------------------------------------------------------------------------
# Sizing / cost knobs
# ---------------------------------------------------------------------------

variable "container_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU, the smallest available)."
  type        = number
  default     = 256
}

variable "container_memory" {
  description = "Fargate task memory in MiB. 512 is the smallest valid pairing with 256 CPU."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  description = "ARM64 (Graviton) costs ~20% less than X86_64 on Fargate."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

variable "use_fargate_spot" {
  description = "Run on FARGATE_SPOT (~70% cheaper, task can be reclaimed with 2 minutes notice)."
  type        = bool
  default     = true
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is the cheapest Graviton option."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS storage in GB. 5 is the floor RDS allows, and only on gp2 (gp3 requires at least 20)."
  type        = number
  default     = 5

  validation {
    condition     = var.db_allocated_storage >= 5
    error_message = "RDS will not accept less than 5 GB."
  }
}

variable "db_storage_type" {
  description = "gp2 permits a 5 GB volume; gp3 starts at 20 GB but has a higher IOPS/throughput baseline."
  type        = string
  default     = "gp2"

  validation {
    condition     = contains(["gp2", "gp3"], var.db_storage_type)
    error_message = "db_storage_type must be gp2 or gp3."
  }

  validation {
    condition     = var.db_storage_type != "gp3" || var.db_allocated_storage >= 20
    error_message = "gp3 volumes must be at least 20 GB; use gp2 for anything smaller."
  }
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. 0 disables backups; 1 is the cheapest useful value (backups up to the DB size are free)."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention. Short retention keeps ingestion/storage cost negligible."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the app. Narrow this to your own IP (e.g. [\"203.0.113.4/32\"]) for a private deployment."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "db_public_access_cidrs" {
  description = "CIDRs allowed to reach Postgres directly. Empty (default) keeps RDS unreachable from the internet; set it only to run psql from your laptop."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# DNS and TLS
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Fully qualified name to serve the app on. Terraform issues a DNS-validated ACM certificate for it and points a Route 53 alias at the load balancer. Setting this turns the load balancer on (~$17/month) because an alias needs a stable target. Leave empty to reach the task by its public IP instead."
  type        = string
  default     = "finance.agvaniya.com"
}

variable "hosted_zone_name" {
  description = "Existing public Route 53 hosted zone that domain_name belongs to."
  type        = string
  default     = "agvaniya.com"
}

variable "tls_mode" {
  description = <<-EOT
    How the app is served:

      letsencrypt — Caddy obtains a Let's Encrypt certificate inside the task
                    (DNS-01 via Route 53) and a Lambda repoints the A record
                    whenever the task's public IP changes. No load balancer,
                    so roughly $17/month cheaper, at the cost of a short
                    outage on every task replacement.
      alb         — Application Load Balancer with an ACM certificate. Costs
                    more, but the address is stable and replacements are
                    seamless.
      none        — plain HTTP on the task's public IP; no domain.
  EOT
  type        = string
  default     = "letsencrypt"

  validation {
    condition     = contains(["letsencrypt", "alb", "none"], var.tls_mode)
    error_message = "tls_mode must be letsencrypt, alb, or none."
  }

  validation {
    condition     = var.tls_mode == "none" || var.domain_name != ""
    error_message = "tls_mode letsencrypt and alb both require domain_name."
  }
}

variable "acme_email" {
  description = "Contact address registered with Let's Encrypt; receives expiry warnings. Required when tls_mode is letsencrypt."
  type        = string
  default     = ""

  validation {
    condition     = var.tls_mode != "letsencrypt" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.acme_email))
    error_message = "tls_mode letsencrypt requires acme_email to be a valid address — Let's Encrypt rejects registrations without a usable contact."
  }
}

variable "acme_staging" {
  description = "Use the Let's Encrypt staging CA. Certificates are untrusted by browsers but the issuance quota is far higher — set this while experimenting so repeated rebuilds cannot exhaust the 5-per-week limit for the real CA."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "Use an existing ACM certificate instead of issuing one. Applies to tls_mode = alb; must live in aws_region."
  type        = string
  default     = ""
}
