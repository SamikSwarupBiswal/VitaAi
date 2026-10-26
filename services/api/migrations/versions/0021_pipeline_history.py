"""Index original pipeline instants without rewriting retained JSON or inventing dates."""
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"


def upgrade():
    op.add_column("pipeline_runs", sa.Column("started_at_us", sa.BigInteger, nullable=True))
    table = sa.table("pipeline_runs", sa.column("id", sa.String), sa.column("payload", sa.JSON),
                     sa.column("started_at_us", sa.BigInteger))
    connection = op.get_bind()
    rows = connection.execute(sa.select(table.c.id, table.c.payload)).mappings()
    for row in rows:
        payload = row["payload"]
        try:
            value = datetime.fromisoformat(payload["started_at"])
            if value.utcoffset() is None:
                continue
            delta = value.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
            instant = (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        connection.execute(table.update().where(table.c.id == row["id"]).values(started_at_us=instant))
    op.create_index("ix_pipeline_history", "pipeline_runs", ["organization_id", "started_at_us", "id"])


def downgrade():
    op.drop_index("ix_pipeline_history", table_name="pipeline_runs")
    op.drop_column("pipeline_runs", "started_at_us")
