output "aws_region" {
  description = "Region the stack is deployed in."
  value       = var.aws_region
}

output "ecr_repository_url" {
  description = "Push target for the application image."
  value       = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.app.name
}

output "cpu_architecture" {
  description = "Architecture the task runs on — deploy.sh builds the image to match."
  value       = var.cpu_architecture
}

output "image_tag" {
  description = "Image tag the service is currently configured to run."
  value       = var.image_tag
}

output "log_group" {
  description = "CloudWatch log group holding application logs."
  value       = aws_cloudwatch_log_group.app.name
}

output "db_endpoint" {
  description = "RDS endpoint (reachable from the task; from your laptop only if db_public_access_cidrs is set)."
  value       = "${aws_db_instance.main.address}:${aws_db_instance.main.port}"
}

output "database_url" {
  description = "Full Postgres connection string (for pg_dump/psql; needs db_public_access_cidrs set to reach it from outside the VPC)."
  value       = local.database_url
  sensitive   = true
}

output "app_url" {
  description = "Where the app is served."
  value = (
    var.tls_mode == "none" ? "http://<task-public-ip>:${local.container_port} (run scripts/deploy.sh or scripts/status.sh for the current address)" :
    "https://${var.domain_name}"
  )
}

output "tls_mode" {
  description = "How TLS is terminated: letsencrypt (in the task), alb, or none."
  value       = var.tls_mode
}

output "domain_name" {
  description = "Custom domain serving the app, if one is configured."
  value       = var.tls_mode == "none" ? "" : var.domain_name
}

output "dns_updater_log_group" {
  description = "Log group for the Lambda that repoints the A record (letsencrypt mode)."
  value       = join("", aws_cloudwatch_log_group.dns_updater[*].name)
}

output "alb_dns_name" {
  description = "Load balancer hostname the Route 53 alias points at."
  value       = local.alb_dns
}
