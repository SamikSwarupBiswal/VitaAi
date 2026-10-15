"""Database constraints for organization-scoped workflow records (migration 0003)."""
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)

from .storage import metadata


def reference(column, table):
    return ForeignKeyConstraint(["organization_id", column], [table + ".organization_id", table + ".id"])


def record(name, *columns):
    return Table(name, metadata, Column("id", String(80), primary_key=True),
                 Column("organization_id", String(80), nullable=False),
                 Column("revision", Integer, nullable=False), Column("payload", JSON, nullable=False),
                 UniqueConstraint("organization_id", "id"), *columns)


plans = record("workflow_plans", Column("account_id", String(80), nullable=False), reference("account_id", "accounts"))
missions = record("workflow_missions", Column("plan_id", String(80), nullable=False),
                  reference("plan_id", "workflow_plans"))
actions = record("workflow_actions", Column("mission_id", String(80), nullable=False),
                 Column("plan_id", String(80), nullable=False), Column("slot_id", String(80), nullable=False),
                 Column("canonical_payload", Text, nullable=False),
                 reference("mission_id", "workflow_missions"), reference("plan_id", "workflow_plans"),
                 UniqueConstraint("organization_id", "mission_id"), UniqueConstraint("organization_id", "slot_id"))
decisions = record("workflow_decisions", Column("action_id", String(80), nullable=False),
                   Column("reviewer_session_hash", String(64), nullable=True),
                   Column("action_revision", Integer, nullable=False), reference("action_id", "workflow_actions"),
                   UniqueConstraint("organization_id", "action_id", "action_revision"))
claims = record("workflow_claims", Column("action_id", String(80), nullable=False),
                Column("decision_id", String(80), nullable=False),
                Column("logical_action_key", String(64), nullable=False),
                Column("idempotency_key", String(200), nullable=False),
                reference("action_id", "workflow_actions"), reference("decision_id", "workflow_decisions"),
                UniqueConstraint("organization_id", "logical_action_key"),
                UniqueConstraint("organization_id", "idempotency_key"))
receipts = record("workflow_receipts", Column("execution_id", String(80), nullable=False),
                  Column("action_id", String(80), nullable=False), Column("decision_id", String(80), nullable=False),
                  reference("execution_id", "workflow_claims"), reference("action_id", "workflow_actions"),
                  reference("decision_id", "workflow_decisions"))
outcomes = record("workflow_outcomes", Column("mission_id", String(80), nullable=False),
                  Column("receipt_id", String(80), nullable=True), reference("mission_id", "workflow_missions"),
                  reference("receipt_id", "workflow_receipts"))
audits = record("workflow_audits", Column("mission_id", String(80), nullable=True),
                Column("sequence", Integer, nullable=False), reference("mission_id", "workflow_missions"),
                UniqueConstraint("organization_id", "sequence"))
versions = Table("workflow_versions", metadata, Column("organization_id", String(80), primary_key=True),
                 Column("entity_id", String(80), primary_key=True), Column("revision", Integer, primary_key=True),
                 Column("entity_type", String(80), nullable=False), Column("payload", JSON, nullable=False))
resources = Table("simulation_resources", metadata, Column("id", String(80), primary_key=True),
                  Column("organization_id", String(80), nullable=False),
                  Column("execution_id", String(80), nullable=False), Column("canonical_payload", Text, nullable=False),
                  reference("execution_id", "workflow_claims"), UniqueConstraint("organization_id", "execution_id"))
