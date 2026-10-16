# Created whenever domain_name is set (or enable_alb is forced on). An ALB
# costs roughly $17/month before traffic, which makes it the second largest
# line item after RDS — but a Route 53 alias needs a stable target, and a
# Fargate task's public IP is not one. It also terminates TLS, which is what
# lets the app use secure cookies.

resource "aws_lb" "app" {
  count = local.alb_enabled ? 1 : 0

  name               = "${var.project_name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = aws_subnet.public[*].id

  idle_timeout = 60
}

resource "aws_lb_target_group" "app" {
  count = local.alb_enabled ? 1 : 0

  name        = "${var.project_name}-tg"
  port        = local.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/login"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 10

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  count = local.alb_enabled ? 1 : 0

  load_balancer_arn = aws_lb.app[0].arn
  port              = 80
  protocol          = "HTTP"

  # With a certificate present, port 80 only exists to bounce clients to TLS.
  dynamic "default_action" {
    for_each = local.serve_https ? [] : [1]

    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.app[0].arn
    }
  }

  dynamic "default_action" {
    for_each = local.serve_https ? [1] : []

    content {
      type = "redirect"

      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.alb_enabled && local.serve_https ? 1 : 0

  load_balancer_arn = aws_lb.app[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}
