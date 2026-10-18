import json

from .config import Settings

# Schema generation needs no local credentials or runtime database configuration.
# Set this before importing app, whose module also creates the default application.
Settings.model_config["env_file"] = None


def schema():
    from .app import create_app
    return create_app(Settings(_env_file=None, database_url="sqlite:///:memory:")).openapi()

if __name__ == "__main__":
    print(json.dumps(schema()))
