"""Versioned governed records, immutable decisions/receipts/audit and durable simulation claims."""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def reference(column, table):
    return sa.ForeignKeyConstraint(["organization_id", column], [table + ".organization_id", table + ".id"])


def record(name, *columns):
    op.create_table(name, sa.Column("id", sa.String(80), primary_key=True),
                    sa.Column("organization_id", sa.String(80), nullable=False),
                    sa.Column("revision", sa.Integer, nullable=False), sa.Column("payload", sa.JSON, nullable=False),
                    sa.UniqueConstraint("organization_id", "id"), *columns)


def upgrade():
    record("workflow_plans", sa.Column("account_id", sa.String(80), nullable=False), reference("account_id", "accounts"))
    record("workflow_missions", sa.Column("plan_id", sa.String(80), nullable=False),
           reference("plan_id", "workflow_plans"))
    record("workflow_actions", sa.Column("mission_id", sa.String(80), nullable=False),
           sa.Column("plan_id", sa.String(80), nullable=False), sa.Column("slot_id", sa.String(80), nullable=False),
           sa.Column("canonical_payload", sa.Text, nullable=False),
           reference("mission_id", "workflow_missions"), reference("plan_id", "workflow_plans"),
           sa.UniqueConstraint("organization_id", "mission_id"), sa.UniqueConstraint("organization_id", "slot_id"))
    record("workflow_decisions", sa.Column("action_id", sa.String(80), nullable=False),
           sa.Column("reviewer_session_hash", sa.String(64), nullable=True),
           sa.Column("action_revision", sa.Integer, nullable=False), reference("action_id", "workflow_actions"),
           sa.UniqueConstraint("organization_id", "action_id", "action_revision"))
    record("workflow_claims", sa.Column("action_id", sa.String(80), nullable=False),
           sa.Column("decision_id", sa.String(80), nullable=False),
           sa.Column("logical_action_key", sa.String(64), nullable=False),
           sa.Column("idempotency_key", sa.String(200), nullable=False),
           reference("action_id", "workflow_actions"), reference("decision_id", "workflow_decisions"),
           sa.UniqueConstraint("organization_id", "logical_action_key"),
           sa.UniqueConstraint("organization_id", "idempotency_key"))
    record("workflow_receipts", sa.Column("execution_id", sa.String(80), nullable=False),
           sa.Column("action_id", sa.String(80), nullable=False), sa.Column("decision_id", sa.String(80), nullable=False),
           reference("execution_id", "workflow_claims"), reference("action_id", "workflow_actions"),
           reference("decision_id", "workflow_decisions"))
    record("workflow_outcomes", sa.Column("mission_id", sa.String(80), nullable=False),
           sa.Column("receipt_id", sa.String(80), nullable=True), reference("mission_id", "workflow_missions"),
           reference("receipt_id", "workflow_receipts"))
    record("workflow_audits", sa.Column("mission_id", sa.String(80), nullable=True),
           sa.Column("sequence", sa.Integer, nullable=False), reference("mission_id", "workflow_missions"),
           sa.UniqueConstraint("organization_id", "sequence"))
    op.create_table("workflow_versions", sa.Column("organization_id", sa.String(80), primary_key=True),
                    sa.Column("entity_id", sa.String(80), primary_key=True),
                    sa.Column("revision", sa.Integer, primary_key=True),
                    sa.Column("entity_type", sa.String(80), nullable=False), sa.Column("payload", sa.JSON, nullable=False))
    op.create_table("simulation_resources", sa.Column("id", sa.String(80), primary_key=True),
                    sa.Column("organization_id", sa.String(80), nullable=False),
                    sa.Column("execution_id", sa.String(80), nullable=False),
                    sa.Column("canonical_payload", sa.Text, nullable=False), reference("execution_id", "workflow_claims"),
                    sa.UniqueConstraint("organization_id", "execution_id"))


def downgrade():
    for name in ("simulation_resources", "workflow_versions", "workflow_audits", "workflow_outcomes", "workflow_receipts", "workflow_claims",
                 "workflow_decisions", "workflow_actions", "workflow_missions", "workflow_plans"):
        op.drop_table(name)
