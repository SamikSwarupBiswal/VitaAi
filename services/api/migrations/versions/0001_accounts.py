"""Freeze the original foundation schema and adopt matching bootstrap databases."""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    metadata = sa.MetaData()
    sa.Table("accounts", metadata,
             sa.Column("id", sa.String(80), primary_key=True),
             sa.Column("organization_id", sa.String(80), nullable=False),
             sa.Column("external_id", sa.String(100), nullable=False),
             sa.Column("revision", sa.Integer, nullable=False),
             sa.Column("payload", sa.JSON, nullable=False),
             sa.UniqueConstraint("organization_id", "external_id"),
             sa.UniqueConstraint("organization_id", "id"))
    sa.Table("evidence", metadata,
             sa.Column("id", sa.String(80), primary_key=True),
             sa.Column("organization_id", sa.String(80), nullable=False),
             sa.Column("account_id", sa.String(80), nullable=False),
             sa.Column("source_record", sa.String(150), nullable=False),
             sa.Column("payload", sa.JSON, nullable=False),
             sa.ForeignKeyConstraint(["organization_id", "account_id"],
                                     ["accounts.organization_id", "accounts.id"]),
             sa.UniqueConstraint("organization_id", "source_record"))
    sa.Table("model_runs", metadata,
             sa.Column("id", sa.String(80), primary_key=True),
             sa.Column("organization_id", sa.String(80), nullable=False),
             sa.Column("account_id", sa.String(80), nullable=False),
             sa.Column("started_at", sa.String(40), nullable=False),
             sa.Column("payload", sa.JSON, nullable=False),
             sa.ForeignKeyConstraint(["organization_id", "account_id"],
                                     ["accounts.organization_id", "accounts.id"]))
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    for table in metadata.sorted_tables:
        if inspector.has_table(table.name):
            columns = {c["name"]: c for c in inspector.get_columns(table.name)}
            if set(columns) != set(table.c.keys()) or any(
                columns[c.name]["type"]._type_affinity != c.type._type_affinity
                or columns[c.name]["nullable"] != c.nullable for c in table.c
            ):
                raise RuntimeError("Bootstrap schema differs from revision 0001; manual review required")
            unique = {tuple(c["column_names"]) for c in inspector.get_unique_constraints(table.name)}
            expected = {tuple(c.columns.keys()) for c in table.constraints if isinstance(c, sa.UniqueConstraint)}
            foreign = {(tuple(c["constrained_columns"]), c["referred_table"], tuple(c["referred_columns"]))
                       for c in inspector.get_foreign_keys(table.name)}
            expected_foreign = {(tuple(c.column_keys), c.referred_table.name,
                                 tuple(e.column.name for e in c.elements))
                                for c in table.constraints if isinstance(c, sa.ForeignKeyConstraint)}
            if (not expected.issubset(unique) or foreign != expected_foreign
                    or inspector.get_pk_constraint(table.name)["constrained_columns"] != ["id"]):
                raise RuntimeError("Bootstrap constraints differ from revision 0001; manual review required")
        else:
            table.create(connection)


def downgrade():
    raise RuntimeError("Destructive foundation downgrade requires an explicit data recovery procedure")
