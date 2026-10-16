# Keeps the A record pointed at the current task.
#
# Without a load balancer there is no stable target, so the record is rewritten
# each time a task reaches RUNNING — after a deploy, a crash, or a Spot
# reclamation. The record carries a 60 second TTL, which bounds how long
# clients keep resolving the departed address.
#
# Running cost is effectively zero: AWS-sourced EventBridge events are free and
# the function runs a handful of times a month.

data "archive_file" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/lambda/update_dns.py"
  output_path = "${path.module}/.build/update_dns.zip"
}

resource "aws_cloudwatch_log_group" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  name              = "/aws/lambda/${var.project_name}-dns-updater"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  name               = "${var.project_name}-dns-updater"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dns_updater[0].arn}:*"]
  }

  # Resource-level permissions are not available for this call.
  statement {
    actions   = ["ec2:DescribeNetworkInterfaces"]
    resources = ["*"]
  }

  statement {
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.main[0].zone_id}"]
  }
}

resource "aws_iam_role_policy" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  name   = "update-dns-record"
  role   = aws_iam_role.dns_updater[0].id
  policy = data.aws_iam_policy_document.dns_updater[0].json
}

resource "aws_lambda_function" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  function_name = "${var.project_name}-dns-updater"
  role          = aws_iam_role.dns_updater[0].arn
  handler       = "update_dns.handler"
  runtime       = "python3.12"
  architectures = ["arm64"]
  timeout       = 30

  filename         = data.archive_file.dns_updater[0].output_path
  source_code_hash = data.archive_file.dns_updater[0].output_base64sha256

  environment {
    variables = {
      HOSTED_ZONE_ID = data.aws_route53_zone.main[0].zone_id
      RECORD_NAME    = var.domain_name
      CLUSTER_ARN    = aws_ecs_cluster.main.arn
      RECORD_TTL     = tostring(local.dns_record_ttl)
    }
  }

  depends_on = [
    aws_iam_role_policy.dns_updater,
    aws_cloudwatch_log_group.dns_updater,
  ]
}

resource "aws_cloudwatch_event_rule" "task_running" {
  count = local.letsencrypt_enabled ? 1 : 0

  name        = "${var.project_name}-task-running"
  description = "Repoint ${var.domain_name} when a Ledgerline task starts"

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn    = [aws_ecs_cluster.main.arn]
      lastStatus    = ["RUNNING"]
      desiredStatus = ["RUNNING"]
    }
  })
}

resource "aws_cloudwatch_event_target" "dns_updater" {
  count = local.letsencrypt_enabled ? 1 : 0

  rule      = aws_cloudwatch_event_rule.task_running[0].name
  target_id = "dns-updater"
  arn       = aws_lambda_function.dns_updater[0].arn
}

resource "aws_lambda_permission" "events" {
  count = local.letsencrypt_enabled ? 1 : 0

  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dns_updater[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.task_running[0].arn
}
