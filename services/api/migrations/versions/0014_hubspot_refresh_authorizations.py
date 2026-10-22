"""Retain append-only, session-bounded staging refresh authorizations."""
import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"


def upgrade():
    op.create_table("hubspot_refresh_authorizations",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("session_hash", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "account_id", "revision"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))


def downgrade():
    raise RuntimeError("Refresh authorization history downgrade requires explicit data review")
