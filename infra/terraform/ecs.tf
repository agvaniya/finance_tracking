data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = var.project_name

  setting {
    name  = "containerInsights"
    value = "disabled" # Container Insights is billed per metric
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by the ECS agent: pull the image, read secrets, write logs.
resource "aws_iam_role" "execution" {
  name               = "${var.project_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.database_url.arn,
      aws_ssm_parameter.app_password.arn,
      aws_ssm_parameter.session_secret.arn,
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Assumed by the application itself. It needs no AWS APIs; these permissions
# exist only so `aws ecs execute-command` can open a debug shell.
resource "aws_iam_role" "task" {
  name               = "${var.project_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

data "aws_iam_policy_document" "task_exec_command" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_command" {
  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_command.json
}

# Caddy answers the ACME DNS-01 challenge by writing a TXT record into the
# hosted zone, so the task itself needs Route 53 access in letsencrypt mode.
data "aws_iam_policy_document" "task_acme_dns" {
  count = local.letsencrypt_enabled ? 1 : 0

  statement {
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
    resources = ["*"]
  }

  statement {
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }

  statement {
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.main[0].zone_id}"]
  }
}

resource "aws_iam_role_policy" "task_acme_dns" {
  count = local.letsencrypt_enabled ? 1 : 0

  name   = "acme-dns-challenge"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_acme_dns[0].json
}

# ---------------------------------------------------------------------------
# Task definition
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "app" {
  family                   = var.project_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.container_cpu
  memory                   = var.container_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # Certificate storage, mounted only in the mode that issues certificates.
  dynamic "volume" {
    for_each = local.letsencrypt_enabled ? [1] : []

    content {
      name = "certs"

      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.certs[0].id
        transit_encryption = "ENABLED"

        authorization_config {
          access_point_id = aws_efs_access_point.certs[0].id
          iam             = "DISABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([{
    name      = "app"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [
      for port in local.letsencrypt_enabled ? [80, 443] : [local.container_port] : {
        containerPort = port
        protocol      = "tcp"
      }
    ]

    mountPoints = local.letsencrypt_enabled ? [{
      sourceVolume  = "certs"
      containerPath = "/data"
      readOnly      = false
    }] : []

    environment = concat(
      [
        { name = "PORT", value = tostring(local.container_port) },
        { name = "NODE_ENV", value = "production" },
        # Without a TLS terminator in front, the browser would discard a cookie
        # marked Secure and login would loop. With HTTPS it stays on.
        {
          name  = "SESSION_COOKIE_SECURE"
          value = local.serve_https ? "true" : "false"
        },
      ],
      local.letsencrypt_enabled ? [
        { name = "CADDY_ENABLED", value = "true" },
        { name = "DOMAIN_NAME", value = var.domain_name },
        { name = "ACME_EMAIL", value = var.acme_email },
        { name = "ACME_STAGING", value = var.acme_staging ? "true" : "false" },
        # Picked up by the Route 53 plugin's AWS SDK credential chain.
        { name = "AWS_REGION", value = var.aws_region },
      ] : [],
    )

    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "APP_PASSWORD", valueFrom = aws_ssm_parameter.app_password.arn },
      { name = "SESSION_SECRET", valueFrom = aws_ssm_parameter.session_secret.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }

    # Lets ECS notice a wedged container even when no load balancer is health
    # checking it. busybox wget ships in the Alpine base image.
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${local.container_port}/login || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 90
    }
  }])
}

# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "app" {
  name            = var.project_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # required to reach ECR/SSM without a NAT gateway
  }

  # One task at a time: the old one stops before the new one starts, so a
  # deployment never pays for two tasks. The tradeoff is a brief gap in
  # service — raise these to 100/200 if you would rather pay for overlap.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  enable_execute_command = true
  propagate_tags         = "SERVICE"

  dynamic "load_balancer" {
    for_each = local.alb_enabled ? [1] : []

    content {
      target_group_arn = aws_lb_target_group.app[0].arn
      container_name   = "app"
      container_port   = local.container_port
    }
  }

  # Give the app time to migrate and boot before the balancer judges it.
  health_check_grace_period_seconds = local.alb_enabled ? 120 : null

  depends_on = [
    aws_ecs_cluster_capacity_providers.main,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution_managed,
  ]
}
