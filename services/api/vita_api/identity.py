"""Local credential identity; no self-registration or client-asserted membership."""
import argparse
import getpass
import hashlib
import hmac
import re
import secrets
import time
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    delete,
    select,
    update,
)

from .contracts import Contract

Role = Literal["admin", "reviewer", "seller", "viewer"]
identity_metadata = MetaData()
users = Table("users", identity_metadata,
              Column("id", String(80), primary_key=True),
              Column("username", String(80), nullable=False, unique=True),
              Column("organization_id", String(80), nullable=False),
              Column("role", String(20), nullable=False),
              Column("password_salt", String(64), nullable=False),
              Column("password_hash", String(128), nullable=False),
              Column("enabled", Boolean, nullable=False),
              Column("failed_logins", Integer, nullable=False),
              Column("locked_until", BigInteger, nullable=False),
              CheckConstraint("role IN ('admin','reviewer','seller','viewer')"))
sessions = Table("sessions", identity_metadata,
                 Column("token_hash", String(64), primary_key=True),
                 Column("user_id", String(80), ForeignKey("users.id"), nullable=False),
                 Column("expires_at", BigInteger, nullable=False))


class Actor(Contract):
    id: str
    username: str
    organization_id: str
    role: Role


class SessionView(Contract):
    mode: Literal["sample", "session"]
    actor: Actor | None = None


class LoginRequest(BaseModel):
    # Password whitespace is significant and must never be silently stripped.
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: SecretStr = Field(min_length=1, max_length=256)


def password_digest(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000).hex()


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginFailure(Exception):
    def __init__(self, locked=False):
        self.locked = locked


class Identity:
    def __init__(self, engine):
        self.engine = engine

    def create_user(self, username: str, password: str, organization_id: str, role: Role) -> Actor:
        if (not re.fullmatch(r"[A-Za-z0-9_.@-]{1,80}", username)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", organization_id)
                or not 12 <= len(password) <= 256):
            raise ValueError("Use a valid username/organization and a password of 12-256 characters")
        actor = Actor(id=str(uuid4()), username=username.lower(), organization_id=organization_id, role=role)
        salt = secrets.token_hex(16)
        with self.engine.begin() as connection:
            connection.execute(users.insert().values(
                **actor.model_dump(exclude={"schema_version"}), password_salt=salt,
                password_hash=password_digest(password, salt), enabled=True, failed_logins=0, locked_until=0,
            ))
        return actor

    def login(self, username: str, password: str, hours: int, previous_token: str | None = None):
        now = int(time.time())
        actor = None
        token = None
        locked = False
        with self.engine.begin() as connection:
            if self.engine.dialect.name == "sqlite":
                # SQLite ignores FOR UPDATE; serialize credential counters and rotation.
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            user = connection.execute(select(users).where(
                users.c.username == username.lower(),
            ).with_for_update()).mappings().first()
            # Equal-cost password derivation for absent and present users.
            salt = user["password_salt"] if user else "00" * 16
            digest = password_digest(password, salt)
            locked = bool(user and user["locked_until"] > now)
            valid = user and hmac.compare_digest(digest, user["password_hash"])
            if valid and user["enabled"] and not locked:
                actor = Actor(**{key: user[key] for key in ("id", "username", "organization_id", "role")})
                token = secrets.token_urlsafe(32)
                if previous_token:
                    connection.execute(delete(sessions).where(sessions.c.token_hash == token_digest(previous_token)))
                connection.execute(delete(sessions).where(sessions.c.expires_at <= now))
                connection.execute(sessions.insert().values(
                    token_hash=token_digest(token), user_id=actor.id, expires_at=now + hours * 3600,
                ))
                connection.execute(update(users).where(users.c.id == actor.id).values(failed_logins=0, locked_until=0))
            elif user and not locked:
                count = user["failed_logins"] + 1 if user["locked_until"] == 0 else 1
                connection.execute(update(users).where(users.c.id == user["id"]).values(
                    failed_logins=count, locked_until=now + 300 if count >= 5 else 0,
                ))
        # Raise after committing failed-attempt counters.
        if actor is None:
            raise LoginFailure(locked)
        return actor, token

    def resolve(self, token: str | None) -> Actor | None:
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        with self.engine.connect() as connection:
            row = connection.execute(select(users).join(sessions, sessions.c.user_id == users.c.id).where(
                sessions.c.token_hash == token_digest(token), sessions.c.expires_at > int(time.time()),
                users.c.enabled.is_(True),
            )).mappings().first()
        return Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")}) if row else None

    def logout(self, token: str | None):
        if token:
            with self.engine.begin() as connection:
                connection.execute(delete(sessions).where(sessions.c.token_hash == token_digest(token)))


if __name__ == "__main__":
    from .config import Settings
    from .storage import Store

    parser = argparse.ArgumentParser(description="Provision one local VitaAi user; password is prompted securely")
    parser.add_argument("username")
    parser.add_argument("organization_id")
    parser.add_argument("--role", choices=["admin", "reviewer", "seller", "viewer"], default="seller")
    args = parser.parse_args()
    password = getpass.getpass("Password (12-256 characters): ")
    if password != getpass.getpass("Confirm password: "):
        raise SystemExit("Passwords differ")
    store = Store(Settings().database_url)
    try:
        store.initialize()
        Identity(store.engine).create_user(args.username, password, args.organization_id, args.role)
        print("User provisioned. No credential was printed.")
    finally:
        store.engine.dispose()
