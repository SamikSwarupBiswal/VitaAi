"""Durable sourced conversation; no action authority."""
import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"


def upgrade():
    op.create_table("companion_sessions",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("actor_id", sa.String(80), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_index("ix_companion_actor", "companion_sessions", ["organization_id", "actor_id", "account_id"])
    op.create_table("companion_turns",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("session_id", sa.String(80), nullable=False),
        sa.Column("request_id", sa.String(80), nullable=False),
        sa.Column("number", sa.Integer, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "session_id", "request_id"),
        sa.UniqueConstraint("organization_id", "session_id", "number"),
        sa.ForeignKeyConstraint(["organization_id", "session_id"], ["companion_sessions.organization_id", "companion_sessions.id"]))


def downgrade():
    raise RuntimeError("Conversation history downgrade requires explicit data review")
