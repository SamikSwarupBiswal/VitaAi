"""Append-only source-quality reports, separate from facts and action review."""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"


def upgrade():
    op.create_table("research_quality_reviews",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("run_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "run_id", "revision"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["research_runs.id"]))


def downgrade():
    raise RuntimeError("Source-quality history downgrade requires explicit data review")
