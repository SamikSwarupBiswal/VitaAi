"""One-time empty-database guard; never use for an initialized service restart."""
import os
import sys
from pathlib import Path

from launch import configuration
from sqlalchemy import create_engine, text


def main():
    try:
        environment, _ = configuration(dict(os.environ))
        engine = create_engine(environment["DATABASE_URL"], connect_args={"connect_timeout": 5})
        try:
            with engine.connect() as connection, connection.begin():
                connection.execute(text("SET TRANSACTION READ ONLY"))
                count = connection.execute(text(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema NOT IN ('pg_catalog','information_schema')"
                )).scalar_one()
        finally:
            engine.dispose()
    except Exception:  # noqa: BLE001 -- CLI boundary: driver errors can contain credentials.
        # This operator boundary must not expose driver errors or private URLs.
        print("VITAAI_PREFLIGHT_FAILED", flush=True)
        return 1
    print(f"VITAAI_PREFLIGHT_NON_SYSTEM_TABLES={count}", flush=True)
    if count != 0:
        return 1
    try:
        os.execve(sys.executable, [sys.executable, str(Path(__file__).with_name("launch.py"))], environment)
    except OSError:
        print("VITAAI_PREFLIGHT_FAILED", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
