"""Durable collaboration and explicitly linked Microsoft identities."""
import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"


def upgrade():
    op.create_table("collaboration_handoffs",
        sa.Column("id", sa.String(80), primary_key=True), sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False), sa.Column("sender_id", sa.String(80), nullable=False),
        sa.Column("recipient_id", sa.String(80), nullable=False), sa.Column("request_id", sa.String(80), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False), sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False), sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "sender_id", "request_id"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_collaboration_account", "collaboration_handoffs", ["organization_id", "account_id"])
    op.create_table("collaboration_events",
        sa.Column("id", sa.String(80), primary_key=True), sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("handoff_id", sa.String(80), nullable=False), sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("request_id", sa.String(80), nullable=False), sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False), sa.UniqueConstraint("organization_id", "handoff_id", "revision"),
        sa.UniqueConstraint("organization_id", "handoff_id", "request_id"),
        sa.ForeignKeyConstraint(["organization_id", "handoff_id"], ["collaboration_handoffs.organization_id", "collaboration_handoffs.id"]))
    op.create_table("platform_identities",
        sa.Column("tenant_id", sa.String(80), primary_key=True), sa.Column("object_id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False), sa.Column("user_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False), sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False), sa.UniqueConstraint("organization_id", "user_id"))
    op.create_table("platform_activities",
        sa.Column("organization_id", sa.String(80), primary_key=True), sa.Column("user_id", sa.String(80), primary_key=True),
        sa.Column("activity_id", sa.String(200), primary_key=True), sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False))


def downgrade():
    raise RuntimeError("Collaboration history downgrade requires explicit data review")
