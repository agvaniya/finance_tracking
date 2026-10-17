# Copy to terraform.tfvars and edit, or let scripts/deploy.sh pass values from
# your .env file. Everything here has a working default except acme_email.
# Application accounts are created through the app's own signup page.

# Registered with Let's Encrypt; receives certificate expiry warnings.
acme_email = "you@example.com"

aws_region   = "us-west-1"
project_name = "ledgerline"

# How the app is served:
#   letsencrypt — Caddy gets a certificate inside the task and a Lambda keeps
#                 the A record on the task's current IP. No load balancer.
#   alb         — Application Load Balancer with an ACM certificate (~$17/mo
#                 more, stable address, seamless replacements).
#   none        — plain HTTP on the task's public IP, no domain.
# tls_mode = "letsencrypt"

# domain_name      = "finance.agvaniya.com"
# hosted_zone_name = "agvaniya.com"

# Use the Let's Encrypt staging CA while experimenting. Certificates will not
# be trusted by browsers, but the real CA only allows 5 identical certificates
# per week and locks you out for days once that is spent.
# acme_staging = true

# Lock access down to your own address, e.g. ["203.0.113.4/32"].
# allowed_cidrs = ["0.0.0.0/0"]

# 5 GB is the smallest volume RDS sells, and only gp2 goes that low —
# gp3 requires at least 20 GB.
# db_allocated_storage = 5
# db_storage_type      = "gp2"

# Run psql from your laptop (opens RDS to these CIDRs).
# db_public_access_cidrs = ["203.0.113.4/32"]

# Trade the Spot discount for an uninterruptible task. Worth considering in
# letsencrypt mode: every reclamation means a new IP and a DNS gap.
# use_fargate_spot = false
