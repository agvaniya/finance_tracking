# Public-subnets-only VPC.
#
# Cost note: the task runs in a public subnet with a public IP so it can reach
# ECR, SSM and CloudWatch through the internet gateway. The usual alternative —
# private subnets — needs either a NAT gateway (~$32/month plus data
# processing) or a set of interface VPC endpoints (~$7/month each). Both cost
# more than everything else here combined, so neither is used. RDS still has no
# public address: it sits in the same subnets with a security group that only
# admits the task's security group.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.project_name}-igw" }
}

# Two subnets in different AZs: RDS requires a subnet group spanning at least
# two availability zones even for a single-AZ instance.
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-public-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project_name}-public" }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "${var.project_name}-app"
  description = "Ledgerline Fargate task"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-app" }
}

# Outbound: pulling the image, reading SSM parameters, shipping logs, Postgres.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Direct access to the task (no load balancer). In letsencrypt mode Caddy
# fronts the app, so the public listeners are 80 and 443 and the application
# port is never exposed; otherwise the app answers on its own port.
resource "aws_vpc_security_group_ingress_rule" "app_direct" {
  for_each = local.alb_enabled ? {} : {
    for pair in setproduct(var.allowed_cidrs, local.app_ingress_ports) :
    "${pair[0]}-${pair[1]}" => { cidr = pair[0], port = pair[1] }
  }

  security_group_id = aws_security_group.app.id
  description       = "Port ${each.value.port} from allowed CIDR"
  cidr_ipv4         = each.value.cidr
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = "tcp"
}

# Access via the load balancer.
resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  count = local.alb_enabled ? 1 : 0

  security_group_id            = aws_security_group.app.id
  description                  = "App port from load balancer"
  referenced_security_group_id = aws_security_group.alb[0].id
  from_port                    = local.container_port
  to_port                      = local.container_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "alb" {
  count = local.alb_enabled ? 1 : 0

  name        = "${var.project_name}-alb"
  description = "Ledgerline load balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count = local.alb_enabled ? length(var.allowed_cidrs) : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTP from allowed CIDR"
  cidr_ipv4         = var.allowed_cidrs[count.index]
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count = local.alb_enabled && local.serve_https ? length(var.allowed_cidrs) : 0

  security_group_id = aws_security_group.alb[0].id
  description       = "HTTPS from allowed CIDR"
  cidr_ipv4         = var.allowed_cidrs[count.index]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  count = local.alb_enabled ? 1 : 0

  security_group_id            = aws_security_group.alb[0].id
  description                  = "To app task"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = local.container_port
  to_port                      = local.container_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "db" {
  name        = "${var.project_name}-db"
  description = "Ledgerline Postgres"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from app task"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# Only created when db_public_access_cidrs is non-empty.
resource "aws_vpc_security_group_ingress_rule" "db_from_admin" {
  count = length(var.db_public_access_cidrs)

  security_group_id = aws_security_group.db.id
  description       = "Postgres from admin CIDR"
  cidr_ipv4         = var.db_public_access_cidrs[count.index]
  from_port         = 5432
  to_port           = 5432
  ip_protocol       = "tcp"
}
