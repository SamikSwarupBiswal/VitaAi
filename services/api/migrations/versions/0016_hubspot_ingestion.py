"""Retain associated-object staging intent and terminal snapshots."""
import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"


def upgrade():
    op.create_table("hubspot_ingestion_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("sequence", sa.Integer, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "account_id", "sequence"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_ingestion_scope", "hubspot_ingestion_runs", ["organization_id", "account_id", "status"])


def downgrade():
    raise RuntimeError("Ingestion downgrade requires explicit data review")
