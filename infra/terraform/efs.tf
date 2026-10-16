# Certificate storage for the in-container TLS mode.
#
# Fargate's task storage is destroyed with the task, so without a durable
# volume Caddy would ask Let's Encrypt for a fresh certificate on every
# replacement. Let's Encrypt allows only 5 identical certificates per week, so
# a handful of Spot reclamations would exhaust the quota and leave the site
# without a usable certificate for days. EFS keeps the account key and
# certificate across task replacements; it holds a few hundred KB, which costs
# well under a cent a month.

resource "aws_efs_file_system" "certs" {
  count = local.letsencrypt_enabled ? 1 : 0

  encrypted = true

  # Nothing here is worth tiering; the data is tiny and read at every boot.
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = { Name = "${var.project_name}-certs" }
}

resource "aws_efs_mount_target" "certs" {
  count = local.letsencrypt_enabled ? length(aws_subnet.public) : 0

  file_system_id  = aws_efs_file_system.certs[0].id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs[0].id]
}

# The access point pins ownership to the container's uid, so the non-root app
# user can write without any chown dance at boot.
resource "aws_efs_access_point" "certs" {
  count = local.letsencrypt_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.certs[0].id

  posix_user {
    uid = local.container_uid
    gid = local.container_uid
  }

  root_directory {
    path = "/caddy"

    creation_info {
      owner_uid   = local.container_uid
      owner_gid   = local.container_uid
      permissions = "0750"
    }
  }

  tags = { Name = "${var.project_name}-certs" }
}

resource "aws_security_group" "efs" {
  count = local.letsencrypt_enabled ? 1 : 0

  name        = "${var.project_name}-efs"
  description = "Ledgerline certificate volume"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-efs" }
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_app" {
  count = local.letsencrypt_enabled ? 1 : 0

  security_group_id            = aws_security_group.efs[0].id
  description                  = "NFS from app task"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}
