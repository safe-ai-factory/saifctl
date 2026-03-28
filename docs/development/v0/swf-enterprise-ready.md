# Enterprise Readiness: Requirements for safe-ai-factory

To elevate `safe-ai-factory` from a state-of-the-art (SOTA) engineering tool to a fully **enterprise-ready** platform, we need to bridge the gap between advanced technical capabilities and organizational management, compliance, and scale.

The project already delivers SOTA security boundaries (Cedar policies, Leash, execution isolation) and reward hacking prevention. Enterprises additionally require robust administrative layers on top of that runtime.

---

## 1. Integration & CI/CD Native Orchestration

Currently, `safe-ai-factory` is heavily CLI-driven (`saifctl feat run`), designed to run on a developer's machine or a single Docker host.

**What's needed:**

- The orchestrator must operate seamlessly as a **GitHub App / GitLab App**.
- Instead of developers running local CLI commands, the factory should be triggerable via webhooks (e.g., creating a Jira ticket, labeling a GitHub issue, or leaving a PR comment like `@agent fix this bug`).
- It needs to integrate directly into existing CI/CD pipelines (GitHub Actions, Jenkins, CircleCI) rather than running alongside them.

---

## 2. Scalability via Kubernetes Orchestration

The current architecture relies on a local Docker daemon (`/var/run/docker.sock`) to spin up disposable containers for the Agent and Test Runner.

**What's needed:**

- To support an engineering org of 500+ developers running thousands of iterations concurrently, the sandbox orchestrator must be **Kubernetes-native (K8s)**.
- Dynamically provision and garbage-collect pods across an EKS/GKE cluster.
- Utilize distributed state caching rather than local file system diffs.

---

## 3. Centralized Cost Management & Quotas

Running autonomous agents in 50-iteration loops can quickly burn through API credits if unchecked. Currently, the project passes local `.env` API keys directly to the agent.

**What's needed:**

- An **Enterprise API Gateway** (similar to a centrally managed LiteLLM proxy) that handles:
  - Hard limits on cost per team, project, or developer.
  - Rate-limiting to prevent a runaway agent from causing a massive spike in OpenRouter/Anthropic bills.
  - Analytics dashboards to visualize AI ROI vs. API expenditure.

---

## 4. Enterprise Context & Multi-Repository Understanding

Currently, the factory uses Shotgun to index the local repository it is running in.

**What's needed:**

- Enterprise codebases are not monoliths; they are complex webs of microservices.
- The agent needs an **Enterprise Context Engine** capable of ingesting and maintaining vector/graph embeddings across:
  - Hundreds of repositories
  - Internal documentation (Confluence/Notion)
  - Standard operating procedures (e.g. `AGENTS.md`)
- The agent must understand how a change in `repo-A` impacts `repo-B` without the developer explicitly providing that context.

---

## 5. Auditability, SIEM Integration, and RBAC

The `safe-ai-factory` has an excellent foundation with Leash logging file and network access to a local HTTP server (`localhost:18080`).

**What's needed:**

- **Log Exporting:** Leash audit logs must be exportable to enterprise SIEM platforms (Datadog, Splunk, CrowdStrike) to monitor for anomalous agent behavior across the organization.
- **Role-Based Access Control (RBAC):** Strict controls dictating:
  - Which agents are allowed to touch which repositories
  - What AWS/GCP secrets they are allowed to mount during the Test Runner phase

---

## 6. Air-Gapped and VPC Deployment Support

For highly regulated industries (Finance, Healthcare, Defense), sending proprietary code to Anthropic or OpenAI is a non-starter.

**What's needed:**

- Support for **fully air-gapped or VPC-bound deployments**.
- Allow organizations to hot-swap hosted models for privately hosted open-weight models (e.g. Llama 3/DeepSeek running on local vLLM instances) while maintaining all the Leash/Cedar policy protections.

---

## Summary

The core engine of `safe-ai-factory` is brilliant. To make it enterprise-ready, the focus must shift from:

> **"How do we safely execute code?"**

to:

> **"How do we deploy, monitor, and pay for 10,000 parallel executions across a distributed organization?"**
