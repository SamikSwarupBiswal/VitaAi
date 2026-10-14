"""Durable local credentials, opaque sessions, and typed pipeline results."""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.create_table("users",
                    sa.Column("id", sa.String(80), primary_key=True),
                    sa.Column("username", sa.String(80), nullable=False, unique=True),
                    sa.Column("organization_id", sa.String(80), nullable=False),
                    sa.Column("role", sa.String(20), nullable=False),
                    sa.Column("password_salt", sa.String(64), nullable=False),
                    sa.Column("password_hash", sa.String(128), nullable=False),
                    sa.Column("enabled", sa.Boolean, nullable=False),
                    sa.Column("failed_logins", sa.Integer, nullable=False),
                    sa.Column("locked_until", sa.BigInteger, nullable=False),
                    sa.CheckConstraint("role IN ('admin','reviewer','seller','viewer')"))
    op.create_table("sessions",
                    sa.Column("token_hash", sa.String(64), primary_key=True),
                    sa.Column("user_id", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
                    sa.Column("expires_at", sa.BigInteger, nullable=False))
    op.create_table("pipeline_runs",
                    sa.Column("id", sa.String(80), primary_key=True),
                    sa.Column("organization_id", sa.String(80), nullable=False),
                    sa.Column("actor_id", sa.String(80), nullable=True),
                    sa.Column("payload", sa.JSON, nullable=False))


def downgrade():
    op.drop_table("pipeline_runs")
    op.drop_table("sessions")
    op.drop_table("users")
