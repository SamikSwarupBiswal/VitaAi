"""Retain immutable source selections, facts and original snapshots."""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade():
    op.create_table("account_source_versions",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("account_revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "account_id", "account_revision"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))


def downgrade():
    raise RuntimeError("Source history downgrade requires explicit data review")
