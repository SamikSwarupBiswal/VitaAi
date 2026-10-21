"""Separate retained narrative context/provenance from research and primary model history."""
import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade():
    op.create_table("research_narrative_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("started_at", sa.BigInteger, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_research_narrative_scope", "research_narrative_runs", ["organization_id", "account_id", "started_at"])


def downgrade():
    raise RuntimeError("Narrative history downgrade requires explicit data review")
