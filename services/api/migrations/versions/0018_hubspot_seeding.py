"""Durable synthetic seed intent, exact review, claim and append-only versions."""
import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"


def upgrade():
    op.create_table("hubspot_seed_jobs",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("sequence", sa.Integer, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("expires_us", sa.BigInteger, nullable=False),
        sa.Column("review_session_hash", sa.String(64)),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.UniqueConstraint("organization_id", "id"),
        sa.UniqueConstraint("organization_id", "account_id", "sequence"),
        sa.ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
    op.create_table("hubspot_seed_versions",
        sa.Column("job_id", sa.String(80), primary_key=True),
        sa.Column("revision", sa.Integer, primary_key=True),
        sa.Column("organization_id", sa.String(80), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.ForeignKeyConstraint(["organization_id", "job_id"], ["hubspot_seed_jobs.organization_id", "hubspot_seed_jobs.id"]))


def downgrade():
    raise RuntimeError("Seed history downgrade requires explicit data review")
