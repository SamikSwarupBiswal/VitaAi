"""Retain secret-free synthetic probe intent and outcomes separately from account inference."""
import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade():
    op.create_table("provider_probe_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("started_at", sa.BigInteger, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False))
    op.create_index("ix_provider_probe_scope", "provider_probe_runs", ["organization_id", "provider", "started_at"])


def downgrade():
    raise RuntimeError("Probe history downgrade requires explicit data review")
