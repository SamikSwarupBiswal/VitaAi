"""Durable bounded research history, separate from authoritative evidence."""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade():
    op.create_table("research_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("started_at", sa.Integer, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_research_account", "research_runs", ["organization_id", "account_id", "started_at"])


def downgrade():
    raise RuntimeError("Research history downgrade requires explicit data review")
