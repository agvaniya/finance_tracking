locals {
  container_port = 3000

  # Matches the uid baked into the image; the EFS access point pins ownership
  # to it so the non-root process can write certificates.
  container_uid = 10001

  dns_record_ttl = 60

  # These drive `count`, so they must be derivable from variables alone —
  # Terraform resolves them during planning, before any resource exists.
  #
  #   alb         — ACM certificate on an Application Load Balancer (~$17/mo)
  #   letsencrypt — Caddy terminates TLS in the task; a Lambda keeps the A
  #                 record pointed at the task's changing public IP
  #   none        — plain HTTP on the task's public IP
  alb_enabled         = var.tls_mode == "alb"
  letsencrypt_enabled = var.tls_mode == "letsencrypt"
  serve_https         = var.tls_mode != "none"

  # Public listeners differ by mode: Caddy owns 80/443, while in the other
  # modes the app itself answers on its own port.
  app_ingress_ports = local.letsencrypt_enabled ? [80, 443] : [local.container_port]

  # join over an empty list yields "", which keeps the outputs free of nulls
  # when there is no load balancer.
  alb_dns = join("", aws_lb.app[*].dns_name)

  # Unknown until the certificate is issued, so this may only be used as an
  # attribute value — never in a count or for_each.
  certificate_arn = try(
    coalesce(var.certificate_arn, one(aws_acm_certificate_validation.app[*].certificate_arn)),
    "",
  )
}
