# Walker.IO — AWS Infrastructure (Terraform)
# Provisions: VPC, EKS, RDS Aurora (PostGIS), ElastiCache Redis

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket = "walkerio-terraform-state"
    key    = "production/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region"   { default = "us-east-1" }
variable "env"           { default = "production" }
variable "db_password"   { sensitive = true }

# ── VPC ──────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "walkerio-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = false  # One per AZ for HA
  enable_dns_hostnames = true

  tags = { Project = "walkerio", Env = var.env }
}

# ── EKS ──────────────────────────────────────────────────────────
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "walkerio-${var.env}"
  cluster_version = "1.29"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    # General workloads (API, services)
    general = {
      name           = "general"
      instance_types = ["c5.xlarge"]
      min_size       = 3
      max_size       = 20
      desired_size   = 3

      labels = { role = "general" }
    }

    # WebSocket nodes — slightly larger for connection state
    websocket = {
      name           = "websocket"
      instance_types = ["c5.2xlarge"]
      min_size       = 2
      max_size       = 15
      desired_size   = 2

      labels = { role = "websocket" }
      taints = [{
        key    = "role"
        value  = "websocket"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  tags = { Project = "walkerio", Env = var.env }
}

# ── Aurora PostgreSQL (PostGIS) ───────────────────────────────────
resource "aws_rds_cluster" "walkerio" {
  cluster_identifier      = "walkerio-${var.env}"
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  database_name           = "walkerio"
  master_username         = "walkerio_admin"
  master_password         = var.db_password
  storage_encrypted       = true
  deletion_protection     = true
  backup_retention_period = 7

  db_subnet_group_name   = aws_db_subnet_group.walkerio.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # Auto-scaling storage (Aurora Serverless-style)
  serverlessv2_scaling_configuration {
    min_capacity = 2
    max_capacity = 64
  }

  tags = { Project = "walkerio", Env = var.env }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "walkerio-writer"
  cluster_identifier = aws_rds_cluster.walkerio.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.walkerio.engine
  engine_version     = aws_rds_cluster.walkerio.engine_version
}

resource "aws_rds_cluster_instance" "reader" {
  count              = 2
  identifier         = "walkerio-reader-${count.index}"
  cluster_identifier = aws_rds_cluster.walkerio.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.walkerio.engine
  engine_version     = aws_rds_cluster.walkerio.engine_version
}

resource "aws_db_subnet_group" "walkerio" {
  name       = "walkerio-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

# ── ElastiCache Redis (Cluster Mode) ─────────────────────────────
resource "aws_elasticache_replication_group" "walkerio" {
  replication_group_id = "walkerio-${var.env}"
  description          = "Walker.IO Redis cluster"

  node_type            = "cache.r6g.large"
  num_cache_clusters   = 3   # 1 primary + 2 replicas per shard
  num_node_groups      = 3   # 3 shards
  replicas_per_node_group = 2

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  subnet_group_name  = aws_elasticache_subnet_group.walkerio.name
  security_group_ids = [aws_security_group.redis.id]

  tags = { Project = "walkerio", Env = var.env }
}

resource "aws_elasticache_subnet_group" "walkerio" {
  name       = "walkerio-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

variable "redis_auth_token" { sensitive = true }

# ── Security Groups ───────────────────────────────────────────────
resource "aws_security_group" "rds" {
  name   = "walkerio-rds-${var.env}"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_security_group" "redis" {
  name   = "walkerio-redis-${var.env}"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

# ── Outputs ───────────────────────────────────────────────────────
output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "rds_endpoint" {
  value     = aws_rds_cluster.walkerio.endpoint
  sensitive = true
}

output "redis_endpoint" {
  value     = aws_elasticache_replication_group.walkerio.primary_endpoint_address
  sensitive = true
}
