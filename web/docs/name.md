# Naming SaifCTL

This document outlines the reasoning behind the naming of the **Safe AI Factory** project, its acronym **SaifCTL**, and the choices we rejected along the way.

## The Full Name: Safe AI Factory

The full name was chosen to explicitly describe what the tool is and how it should be perceived by engineering teams and enterprise buyers (CTOs, CISOs, EMs).

- **Safe:** Emphasizes our core value proposition—zero-trust, sandboxed, and protected AI execution. It contrasts with the "reckless" nature of giving AI open-ended access to your terminal.
- **AI:** Clearly states the domain.
- **Factory:** The concept of "Software factories" is getting popular - a system that autonomously builds software from specifications using AI agents. A factory implies predictability, assembly lines, repeatable processes, and strict quality control (the Gauntlet).

## The Acronym & CLI: SaifCTL

Developers need a short, snappy acronym for CLI commands and daily conversation. We chose **SaifCTL** (`saifctl`).

**Why SaifCTL works:**

1. **Zero Collision Risk:** There are virtually no tech companies, AI tools, or open-source projects using the name SaifCTL. It provides a completely clean slate for SEO and GitHub discoverability.
2. **CLI Ergonomics:** `saifctl run` is a distinct, easy-to-type, 6-character command that feels like a proper binary (similar to `kubectl` or `podman`).

## Rejected Alternatives

### Why not SAIF?

Initially, we considered using just "SAIF" (Safe AI Factory). While linguistically clean (meaning "sword" or "protector" in Arabic), it carries **massive branding and trademark risks** in the tech space:

- **Google's SAIF:** Google heavily markets their "Secure AI Framework" as SAIF (`saif.google`). Competing with Google for this acronym in the exact same domain (AI safety/security) would make discoverability impossible.
- **SAIF Autonomy / SAIF Systems:** An existing UK-based deep-tech venture builder focused on AI runtime assurance.
- **SAIF CHECK:** A Saudi-based AI risk assessment platform.

Using SAIF would have buried the project in search results and invited trademark confusion.

### Why not SAIFER?

We also explored "SAIFER" (pronounced _safer_).

- **The Pro:** It literally sounds like the word "safer," aligning with our value prop.
- **The Fatal Flaw:** Fidelity Investments launched a well-funded RegTech/AI compliance company called **Saifr** (`saifr.ai`). Because they operate in the AI risk and compliance space, using an identical-sounding name would lead to immediate trademark conflicts and brand confusion.

### Why not verb-heavy domains (e.g. get* brands) or saif.ac?

When looking for domains:

- **Verb-prefixed names (e.g. `getsaifctl.com`):** Adding verbs like "get" or "try" to domains is increasingly seen as a sign of an immature startup or a temporary workaround. We wanted a permanent, professional home.
- **`saif.ac`:** While a clever "domain hack," the `.ac` extension is globally recognized as the domain for Academic Institutions. Using it for a commercial B2B zero-trust security tool would confuse enterprise firewalls and buyers.
