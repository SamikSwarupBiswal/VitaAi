"""Durable sourced mission/source memories and append-only lifecycle history."""
import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"


def upgrade():
    op.create_table("source_memory_entries",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("source_key", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "source_key"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_source_memory_account", "source_memory_entries", ["organization_id", "account_id"])
    op.create_table("source_memory_events",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("memory_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "memory_id", "revision"),
        sa.ForeignKeyConstraint(["organization_id", "memory_id"], ["source_memory_entries.organization_id", "source_memory_entries.id"]))


def downgrade():
    raise RuntimeError("Sourced-memory downgrade requires explicit data review")
