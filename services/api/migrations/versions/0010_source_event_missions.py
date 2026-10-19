"""Atomically bind each selected source event to one governed mission."""
import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade():
    op.create_table("source_event_missions",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("detection_id", sa.String(80), nullable=False),
        sa.Column("event_id", sa.String(80), nullable=False),
        sa.Column("plan_id", sa.String(80), nullable=False),
        sa.Column("mission_id", sa.String(80), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "detection_id"),
        sa.UniqueConstraint("organization_id", "event_id"),
        sa.UniqueConstraint("organization_id", "plan_id"),
        sa.UniqueConstraint("organization_id", "mission_id"),
        sa.ForeignKeyConstraint(["detection_id"], ["hubspot_source_detections.id"]),
        sa.ForeignKeyConstraint(["organization_id", "plan_id"], ["workflow_plans.organization_id", "workflow_plans.id"]),
        sa.ForeignKeyConstraint(["organization_id", "mission_id"], ["workflow_missions.organization_id", "workflow_missions.id"]))


def downgrade():
    raise RuntimeError("Source mission history downgrade requires explicit data review")
