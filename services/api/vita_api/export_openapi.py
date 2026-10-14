import json

from .app import app

if __name__ == "__main__":
    print(json.dumps(app.openapi()))
