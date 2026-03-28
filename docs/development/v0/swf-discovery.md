# Software Factory Discovery Step (`saifctl feat design-discovery`)

This document outlines the rationale behind the `design-discovery` step, what it does, and how it is implemented under the hood.

## Rationale: Why do we need a Discovery Step?

Our standard design pipeline relies heavily on [Shotgun](https://github.com/shotgun-sh/shotgun) via the `saifctl feat design-specs` command. Shotgun is excellent at analyzing _internal_ codebase state. It creates a vector index of the local repository, looks for relevant coding patterns, and uses that RAG context to enrich the user's `proposal.md` into comprehensive specifications (`specification.md`, `plan.md`, `tasks.md`).

However, Shotgun is constrained to the _local codebase_. It cannot easily look outside the project boundary to gather external context.

We often encounter features that depend heavily on external context:

- Integrating with a third-party API (needs external schemas or documentation)
- Reading a Jira ticket or Notion document to get exact acceptance criteria
- Querying an internal microservice or architecture registry to understand how to connect to it
- Using a web browser to scrape the layout of a competitor's page before designing a new UI

We introduced **Design Discovery** to act as a generic bridge. It is an optional, highly extensible prep-step that runs an AI agent armed with user-provided tools (either MCP servers or local scripts) _before_ Shotgun runs. It translates external context into a static markdown file (`discovery.md`) that Shotgun can easily ingest.

## What it does

When the user runs `saifctl feat design` (or `saifctl feat design-discovery`), the pipeline checks if any discovery tools (`discoveryMcps` or `discoveryTools`) are configured via CLI arguments or the project `config.json`.

If configured, the Orchestrator does the following:

1. Loads all configured tools.
2. Reads the feature's `proposal.md`.
3. Creates a [Mastra Agent](https://mastra.ai/docs/agents) provisioned with these tools.
4. Instructs the agent to "Gather all necessary context using your tools, then output a structured markdown document with your findings." (An optional custom prompt can be appended here).
5. Writes the agent's output to `saifctl/features/<name>/discovery.md`.

Once `discovery.md` exists, the subsequent `saifctl feat design-specs` step automatically detects it and injects it into Shotgun alongside the original `proposal.md`. Shotgun treats this discovered context as part of the project reality, using it to inform the final specs and test plans.

## Architecture and Implementation

### 1. Tool Resolution (`src/design-discovery/tools.ts`)

Discovery tools come in two flavors: **MCP Servers** and **Local JS/TS tools**.

- **MCP (Model Context Protocol) Integration:**
  The feature accepts `--discovery-mcp name=url` arguments. We specifically require HTTP(S) URLs that support the `StreamableHTTPClientTransport` from the official `@modelcontextprotocol/sdk`. We connect to the MCP server, list its capabilities (`client.listTools()`), and use a wrapper function (`wrapMcpTool`) to convert the MCP tool signatures into native Mastra `Tool` instances.
- **Local Scripts Integration:**
  Users can pass `--discovery-tool ./scripts/my-tools.ts`. The implementation uses [jiti](https://github.com/unjs/jiti) to dynamically import the TypeScript file at runtime (bypassing the need to pre-compile the user's tool file). We expect the file to `export default { toolName: Tool }`, and we map these directly into the agent.

### 2. The Agent Execution (`src/design-discovery/agent.ts` & `run.ts`)

The execution is powered directly by Mastra.

We construct a single `DiscoveryAgent`. The system prompt combines a hardcoded preamble with an optional user-defined override (`--discovery-prompt` or `--discovery-prompt-file`).

The hardcoded preamble firmly dictates the agent's goal:

> "Your objective is to read the user's feature proposal and use your available tools to gather necessary architectural, API, and system context before the feature is designed. Output your findings as a structured markdown document. Focus on facts, constraints, and schemas that will prevent the downstream designer from hallucinating."

The agent processes the proposal, calls tools autonomously using standard LLM function calling, and streams back the result. The orchestrator captures the final output and writes it to `discovery.md`.

### 3. Pipeline Integration (`src/cli/commands/feat.ts`)

The `design-discovery` command is cleanly separated but orchestrated into the larger `saifctl feat design` flow.

The pipeline executes sequentially:

1. `_runDesignDiscovery` (if `shouldRunDiscovery()` is true based on loaded options).
2. `_runDesignSpecs` (Shotgun step; automatically absorbs `discovery.md`).
3. `_runDesignTests` (Generates test plans).
4. `_runDesignFail2pass` (Validates the tests fail against main).

This ensures the boundary between "external research" (Discovery) and "internal specification" (Shotgun) is maintained as static, reviewable markdown files, aligning perfectly with the factory's philosophy of deterministic, human-readable intermediate steps.

## FAQ

### Why explicitly define MCPs and Tools instead of using a generic browsing agent?

If we just gave a powerful LLM generic tools to "browse the web" or "run bash scripts" (like OpenHands or Aider do), it could theoretically gather context on its own. However, we force explicitly defined tools/MCPs for several strong reasons:

1. **Security and Sandboxing:** The core ethos of the "Safe AI Factory" is strict security boundaries. If we give a generic agent `curl`, `bash`, and full network access during the Discovery phase, we are essentially running an untrusted generic agent on the host system. By restricting the Discovery agent to _only_ the specific MCPs and Tools you explicitly provide (e.g., an internal Swagger API MCP, a Read-Only Jira MCP), you maintain tight control over its capabilities.
2. **Authentication:** Many places where you need "discovery" context are behind corporate firewalls or require authentication (internal Notion pages, Jira tickets, private GitHub repos). A generic browser agent hits login screens. An explicitly defined MCP server handles the authentication natively and exposes clean API methods to the agent.
3. **Reliability and Speed:** Web scraping agents are slow and flaky—they get stuck on cookie banners or fail to parse dynamic React UIs. If an MCP server simply outputs a structured OpenAPI JSON schema, the agent gets exactly what it needs in 2 seconds.
4. **Context Window Management:** Generic discovery agents often fill their context windows with irrelevant HTML garbage or massive terminal outputs. Explicit tools return structured, high-signal data, saving massive amounts of token costs and preventing context window blowout.
