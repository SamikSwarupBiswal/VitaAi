VitaAi
======

VitaAi connects customer signals and sourced evidence to account priorities,
reviewed recommendations, and governed account missions. The web application
provides executive, seller, and operations views over a shared Python API.
Generated advice cannot grant approval or replace deterministic policy. Provider
execution, verification, and separately reported outcomes have distinct states.

Start a local synthetic instance
-------------------------------

Prerequisites: an operator-managed Docker Engine using Linux containers and
Docker Compose v2.17 or later. Builds download public images and dependencies.
The container configuration is provided for local use; actual Docker startup,
health, volume ownership, and restart behavior still require runtime validation.
Read deploy/local/SETUP.txt before running these commands from this directory.

  docker compose -p vitaai-local -f deploy/local/compose.json config --quiet
  docker compose -p vitaai-local -f deploy/local/compose.json build
  docker compose -p vitaai-local -f deploy/local/compose.json up -d --wait

Use a new project name for each separate synthetic instance, consistently on all
commands. The API initializes six labeled synthetic accounts in a new named
SQLite volume. There are no default credentials. Provision a local reviewer:

  docker compose -p vitaai-local -f deploy/local/compose.json exec api python -m vita_api.identity local-reviewer vitaai-sample --role reviewer

The CLI securely prompts for a password twice. Open http://127.0.0.1:3000 and
sign in. Provision other roles separately only when the local flow needs them.
The API is internal to the shared API/web network namespace. Host .env files,
provider credentials, integration gates, and scheduled workers are not inherited.
No live provider or customer action is configured by this procedure.

Inspect status with the same project name:

  docker compose -p vitaai-local -f deploy/local/compose.json ps

API health checks schema readiness; web health checks its session gateway. These
checks do not establish provider health or release acceptance. Preserve state
when investigating a failure. Ordinary down preserves the named volume; do not
use down --volumes or prune data you need. Follow deploy/local/SETUP.txt for
failure investigation and explicit restart-preservation checks.

Verify committed source without Docker
--------------------------------------

Prerequisites: Git, Python with venv/pip, Node.js >=20.9, and npm on PATH. From
this directory, choose a new external output directory whose parent exists:

  python scripts/check-clean-setup.py --output C:/private/vitaai-clean-check-001

The checker exports committed HEAD without Git history, installs fresh Python
and npm dependencies, builds the web application, checks packaged synthetic
assurance evidence, and measures isolated SQLite API reconstruction. It retains
the exact revision, commands, logs, results, and evidence limits externally.
Installation accesses package registries. Existing output is never overwritten.
Uncommitted changes are not tested; this does not establish Docker, browser,
real-provider, tenant, or hosted acceptance. Full procedure: deploy/local/SETUP.txt.

Prepare a hosted candidate
--------------------------

Read deploy/hosted/SETUP.txt for the separate single-container web/API candidate.
It requires matching HTTPS origins, secure sessions and external PostgreSQL;
it does not deploy, provision default accounts or establish hosted acceptance.

Third-party notices and distribution
-----------------------------------

The offline scripts/license-inventory.py and scripts/license-notices.py inspect
installed dependency declarations and package-owned legal texts. The notice
collector preserves exact bytes and hashes, including bounded nested npm legal
files, in a new external directory. Explicit --ecosystem python or npm and
--root select a standalone environment or preserved web installation; Python
always comes from the running interpreter. See deploy/local/SETUP.txt for commands,
coverage gaps, and source/output constraints. Installed dependency coverage is
not complete attribution, source-obligation review, or legal compatibility.

VitaAi's original project code is licensed under the MIT License; see LICENSE.
Third-party components retain their own licenses. Optional dependencies,
base-image/OS components, bundled component identity, live integrations, hosted
identity/OAuth, device behavior, and full release acceptance require separate
review or validation. No deployment or publication is performed by these tools.
