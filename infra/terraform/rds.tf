resource "random_password" "db" {
  length = 32
  # Alphanumeric only: the password is embedded in a connection URL, and this
  # sidesteps percent-encoding entirely.
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project_name}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  # 5 GB is the smallest volume RDS sells, and gp2 is the only general-purpose
  # type that goes that low (gp3 starts at 20 GB). At this size gp2's baseline
  # is 100 IOPS with burst credits, which is ample for a single-user app but
  # worth revisiting if the workload ever grows.
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = 0 # no storage autoscaling — keeps the bill predictable
  storage_type          = var.db_storage_type
  storage_encrypted     = true

  db_name  = "ledgerline"
  username = "ledgerline"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  # Public addressing is off unless you explicitly list admin CIDRs; the app
  # reaches the database over private VPC addresses either way.
  publicly_accessible = length(var.db_public_access_cidrs) > 0

  multi_az                     = false # single AZ: half the cost of multi-AZ
  backup_retention_period      = var.db_backup_retention_days
  backup_window                = "07:00-07:30"
  maintenance_window           = "Mon:08:00-Mon:08:30"
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false # billed beyond the 7-day free tier on some classes
  monitoring_interval          = 0     # enhanced monitoring is billed per instance

  # Teardown should be easy for a personal deployment. Flip both of these for
  # anything you would be upset to lose.
  skip_final_snapshot = true
  deletion_protection = false

  apply_immediately = true
}
