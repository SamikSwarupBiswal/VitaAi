"""Add read-only HubSpot staging without changing facts or governed records."""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade():
    op.create_table("hubspot_observations",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("sequence", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "account_id", "sequence"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_table("hubspot_sync_runs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("observation_id", sa.String(80), nullable=True),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
        sa.ForeignKeyConstraint(["organization_id", "observation_id"],
                                ["hubspot_observations.organization_id", "hubspot_observations.id"]))


def downgrade():
    raise RuntimeError("HubSpot staging downgrade requires explicit data review")
