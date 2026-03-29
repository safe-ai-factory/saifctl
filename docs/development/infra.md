# Infrastructure Tracking (`LiveInfra`)

Safe AI Factory (SaifCTL) orchestrates complex, isolated environments for agents and tests. To ensure no resources leak, to handle failures gracefully, and to support pausing/resuming runs, we internally track all provisioned resources using the `LiveInfra` object.

## Overview

The `LiveInfra` object is a strict tally of all infrastructure resources created during a run. Rather than querying the host system (e.g., Docker) to guess what might belong to a run, the engine appends to this object synchronously as it creates resources. When it's time to clean up, the engine iterates over the exact list of recorded items and removes them.

This robust tracking enables:
- **Deterministic Teardowns:** We know exactly which containers, networks, and images to remove, even if the run crashed halfway through setup.
- **Run Pausing and Resuming:** We can save the state of the infrastructure to the persistent run artifact (`RunLiveInfra`) and accurately verify or restore it when a paused run resumes.
- **Dashboards and Inspection:** We can map active resources (like the coder container or background databases) directly to an active run.

## `LiveInfra` Types

The exact structure of `LiveInfra` depends on the active Engine (e.g., Docker, Local, or Helm). 

### `DockerLiveInfra`
For the Docker engine, `DockerLiveInfra` tracks:
- `networkName`: The isolated bridge network created specifically for the run.
- `stagingImages`: Ephemeral Docker images built for the staging application.
- `containers`: A list of all running or stopped containers (e.g., staging app, test-runner, coder agent).

### `LocalLiveInfra`
Nothing is tracked when running agent on the host machine.

## Coding vs Staging

We track separately the infrastructure for the agent's coding environment and the staging environment used for testing:

- **`coding`**: `coder` container, isolated bridge network, and background databases spun up via Docker Compose.
- **`staging`**: `staging` app container, `test-runner` container, and any freshly built images.

This separation allows SaifCTL to tear down the staging environment entirely after tests complete, without affecting the coding environment. It also lets us safely freeze the coding environment during a `run pause`.

## The Lifecycle

The orchestrator passes the `LiveInfra` object sequentially through the engine lifecycle:

1. **Setup**: The engine initializes the base infrastructure (e.g., an isolated network, starting Compose services) and returns an initial `LiveInfra` object via `Engine.setup()`.
2. **Execution**: As new components are created, they are appended to the infra state. The updated object is returned by each step:
   - `Engine.startStaging()` appends the staging app container and images.
   - `Engine.runTests()` appends the test-runner container.
   - `Engine.runAgent()` appends the coder container.
3. **Teardown**: The orchestrator or cleanup registry calls `Engine.teardown()`. The engine uses the provided object to deterministically stop and remove all listed containers, images, compose projects, and networks without making assumptions.

By threading the `LiveInfra` object from step to step, each engine operation has a precise inventory of what is currently running, making resource management both predictable and leak-free.
