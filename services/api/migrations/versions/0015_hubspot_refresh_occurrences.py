"""Reserve scheduled staging occurrences before network access."""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade():
    op.create_table("hubspot_refresh_occurrences",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("authorization_id", sa.String(80), nullable=False),
        sa.Column("slot", sa.Integer, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("authorization_id", "slot"),
        sa.ForeignKeyConstraint(["authorization_id"], ["hubspot_refresh_authorizations.id"]),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_refresh_occurrence_scope", "hubspot_refresh_occurrences",
                    ["organization_id", "account_id", "status"])


def downgrade():
    raise RuntimeError("Refresh occurrence downgrade requires explicit data review")
