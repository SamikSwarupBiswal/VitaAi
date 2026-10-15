"""Preserve historical actions and claims while allowing one stable slot per plan step."""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade():
    connection = op.get_bind()
    constraints = sa.inspect(connection).get_unique_constraints("workflow_actions")
    name = next(item["name"] for item in constraints
                if item["column_names"] == ["organization_id", "mission_id"])
    convention = {"uq": "uq_%(table_name)s_%(column_0_name)s_%(column_1_name)s"}
    with op.batch_alter_table("workflow_actions", naming_convention=convention) as batch:
        batch.drop_constraint(name or "uq_workflow_actions_organization_id_mission_id", type_="unique")
        batch.add_column(sa.Column("step_id", sa.String(80), nullable=True))
        batch.create_unique_constraint("uq_workflow_action_step", ["organization_id", "mission_id", "step_id"])


def downgrade():
    raise RuntimeError("Action-slot downgrade requires explicit data review; no automatic destructive downgrade")
