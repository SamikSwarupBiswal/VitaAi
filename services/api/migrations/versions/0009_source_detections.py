"""Durable per-source detection cursor and immutable change occurrences."""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade():
    op.create_table("hubspot_source_detections",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("source_version_id", sa.String(80), nullable=False),
        sa.Column("account_revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "account_id", "account_revision"),
        sa.UniqueConstraint("organization_id", "source_version_id"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
        sa.ForeignKeyConstraint(["source_version_id"], ["account_source_versions.id"]))


def downgrade():
    raise RuntimeError("Source detection history downgrade requires explicit data review")
