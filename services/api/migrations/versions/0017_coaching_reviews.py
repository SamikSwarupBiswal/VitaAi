"""Append-only human coaching reviews, separate from action approval."""
import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"


def upgrade():
    op.create_table("workflow_coaching_reviews",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.Column("mission_id", sa.String(80), nullable=False),
        sa.Column("outcome_id", sa.String(80), nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "mission_id", "revision"),
        sa.ForeignKeyConstraint(["organization_id", "mission_id"],
                                ["workflow_missions.organization_id", "workflow_missions.id"]),
        sa.ForeignKeyConstraint(["organization_id", "outcome_id"],
                                ["workflow_outcomes.organization_id", "workflow_outcomes.id"]))


def downgrade():
    raise RuntimeError("Coaching history downgrade requires explicit data review")
