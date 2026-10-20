"""Keep provider comparison snapshots and independent run provenance separate from primary model runs."""
import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade():
    op.create_table("provider_comparison_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("started_at", sa.BigInteger, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_provider_comparison_scope", "provider_comparison_runs", ["organization_id", "account_id", "started_at"])


def downgrade():
    raise RuntimeError("Comparison history downgrade requires explicit data review")
