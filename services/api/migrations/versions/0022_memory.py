"""Durable sourced memory and append-only lifecycle; no historical backfill."""
import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"


def upgrade():
    op.create_table("memory_entries",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("source_key", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "source_key"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
        sa.CheckConstraint("revision >= 1"),
        sa.CheckConstraint("state IN ('active','archived','invalidated')"))
    op.create_index("ix_memory_account", "memory_entries", ["organization_id", "account_id", "id"])
    op.create_table("memory_events",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("memory_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "memory_id", "revision"),
        sa.ForeignKeyConstraint(["organization_id", "memory_id"], ["memory_entries.organization_id", "memory_entries.id"]),
        sa.CheckConstraint("revision >= 1"))


def downgrade():
    raise RuntimeError("Memory history downgrade requires explicit data review")
