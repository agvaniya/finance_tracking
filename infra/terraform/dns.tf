# Route 53 records, and the ACM certificate used by the load balancer mode.
#
# In letsencrypt mode the certificate is obtained inside the task instead (see
# the Caddy configuration in docker-entrypoint.sh), and the A record here is
# only a placeholder — the Lambda in dns_updater.tf rewrites it with the
# current task's public IP every time a task starts.

data "aws_route53_zone" "main" {
  count = var.tls_mode == "none" ? 0 : 1

  name         = var.hosted_zone_name
  private_zone = false
}

# ---------------------------------------------------------------------------
# Load balancer mode: ACM certificate, DNS-validated, aliased from the zone
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "app" {
  count = local.alb_enabled && var.certificate_arn == "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# One certificate for one name means exactly one validation record, so this
# uses count rather than for_each: the validation values are not known until
# apply, and for_each keys have to be resolvable during planning.
resource "aws_route53_record" "cert_validation" {
  count = local.alb_enabled && var.certificate_arn == "" ? 1 : 0

  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = tolist(aws_acm_certificate.app[0].domain_validation_options)[0].resource_record_name
  type            = tolist(aws_acm_certificate.app[0].domain_validation_options)[0].resource_record_type
  records         = [tolist(aws_acm_certificate.app[0].domain_validation_options)[0].resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count = local.alb_enabled && var.certificate_arn == "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = aws_route53_record.cert_validation[*].fqdn
}

# Alias targets are free to query and, unlike a CNAME, work at a zone apex.
resource "aws_route53_record" "app_alias" {
  count = local.alb_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app[0].dns_name
    zone_id                = aws_lb.app[0].zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# Let's Encrypt mode: a record the Lambda owns
# ---------------------------------------------------------------------------

# Created with a documentation address (TEST-NET-1) purely so the record
# exists and is destroyed with the stack. The Lambda replaces the value within
# seconds of the first task reaching RUNNING, so Terraform deliberately ignores
# drift on it — otherwise every plan would try to undo the live address.
resource "aws_route53_record" "app_task" {
  count = local.letsencrypt_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = local.dns_record_ttl
  records = ["192.0.2.1"]

  lifecycle {
    ignore_changes = [records]
  }
}
