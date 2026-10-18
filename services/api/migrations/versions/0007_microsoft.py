"""Durable encrypted OAuth state and delegated mailbox credentials."""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade():
    for name, columns in [
        ("microsoft_flows", [sa.Column("consumed", sa.Boolean, nullable=False),
                             sa.Column("encrypted_flow", sa.Text, nullable=False)]),
        ("microsoft_bindings", [sa.Column("mailbox_id", sa.String(80), nullable=False),
                                sa.Column("revoked", sa.Boolean, nullable=False),
                                sa.Column("encrypted_token", sa.Text, nullable=False)]),
    ]:
        op.create_table(name, sa.Column("id", sa.String(80 if name == "microsoft_bindings" else 64), primary_key=True),
            sa.Column("organization_id", sa.String(80), nullable=False),
            sa.Column("actor_id", sa.String(80), nullable=False),
            sa.Column("session_hash", sa.String(64), nullable=False),
            sa.Column("configuration", sa.String(64), nullable=False),
            sa.Column("expires_at", sa.Integer, nullable=False), *columns)


def downgrade():
    raise RuntimeError("OAuth history downgrade requires explicit data review")
