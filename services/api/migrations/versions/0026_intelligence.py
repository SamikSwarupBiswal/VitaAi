"""Durable isolated what-if and observed trend records."""
import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"


def upgrade():
    for name in ("intelligence_scenarios", "intelligence_promotions", "intelligence_trends"):
        extra = []
        if name == "intelligence_scenarios":
            extra = [sa.Column("author_id", sa.String(80), nullable=False),
                     sa.Column("request_id", sa.String(80), nullable=False),
                     sa.UniqueConstraint("organization_id", "author_id", "request_id")]
        elif name == "intelligence_promotions":
            extra = [sa.Column("scenario_id", sa.String(80), nullable=False),
                     sa.UniqueConstraint("organization_id", "scenario_id"),
                     sa.ForeignKeyConstraint(["organization_id", "scenario_id"],
                         ["intelligence_scenarios.organization_id", "intelligence_scenarios.id"])]
        op.create_table(name, sa.Column("id", sa.String(80), primary_key=True),
            sa.Column("organization_id", sa.String(80), nullable=False),
            sa.Column("account_id", sa.String(80), nullable=False),
            sa.Column("revision", sa.Integer, nullable=False), sa.Column("payload", sa.JSON, nullable=False),
            sa.UniqueConstraint("organization_id", "id"),
            sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]), *extra)
        op.create_index("ix_" + name + "_account", name, ["organization_id", "account_id"])


def downgrade():
    raise RuntimeError("Scenario/trend history downgrade requires explicit data review")
