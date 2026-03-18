# Persona: The Product Manager (PM)

## 1. Profile & Perspective

The Product Manager (PM) is the source of truth for _what_ needs to be built and _why_. They do not write code, but their entire success is predicated on how fast and accurately the engineering team can translate their requirements into shipped features. They are chronically frustrated by the "translation gap"—the phenomenon where a perfectly clear product spec turns into software that misses the mark, requiring weeks of revisions. They view engineering as an opaque machine where Jira tickets go to linger.

**Core Philosophy:** "My job is to discover what the user needs and ensure we build exactly that. I want a system where my intent is perfectly preserved from the initial idea all the way to the shipped code, without having to micromanage developers every step of the way, and where sprint timelines are actually predictable."

## 2. Core Wants & Desires

- **Predictability & ROI:** They want to stop looking bad in front of stakeholders when a 2-week sprint turns into a 6-week slog. They need reliable delivery.
- **Faster Time-to-Market:** They want to see their ideas in the hands of users as quickly as possible.
- **Exact Alignment:** They want the final product to match their initial vision perfectly, without "engineering compromises" that silently drop crucial edge cases.
- **Transparency:** They want to know exactly where a feature is in the pipeline without having to decipher Git commit hashes or ask engineers for updates on Slack.
- **Focus on the "What," Not the "How":** They want to provide business logic and user flows, and leave the technical implementation details to the engineers (or the AI).

## 3. Deep-Seated Fears & Objections

- **The "Lost in Translation" Fear:** "I wrote a 5-page product requirement document (PRD), and by the time it went through the engineer and into the AI, half the acceptance criteria were ignored."
- **The Bottleneck Objection:** "If this new 'SAIFAC' system requires perfectly formatted, machine-readable, hyper-technical specs, I'm going to become the bottleneck. I don't know how to write database schemas."
- **The Quality Regression Fear:** "If we start letting AI write the code, the user experience (UX) and product quality will degrade into a generic, buggy mess that passes tests but fails the user."

## 4. How SAIFAC Addresses the Persona (The PM Value Proposition)

### Addressing Fears & Objections

| The Fear                              | The SAIFAC Solution                                                                                                                                                                                                                                                                                                                         |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Lost in Translation"**             | **Spec-Driven Enforcement via the IC.** The PM's proposal goes to the engineer (IC), who uses SAIFAC to generate a `specification.md` and `tests.json`. The IC embeds the nuances and edge cases. The AI cannot merge the code until it passes every single test derived from the PM's original intent, overseen by the IC.                 |
| **"I have to write technical specs"** | **IC as the Translator.** The PM writes a simple, plain-English Jira ticket or proposal outlining the business logic. The PM stays out of the weeds. The engineer uses SAIFAC's Spec Agent to translate that brain-dump into the rigorous, technical `specification.md`. For the PM, the technical spec is merely an implementation detail. |
| **"Quality will degrade"**            | **Functional Alignment & Staging Previews.** SAIFAC guarantees functional alignment via strict TDD. But to ensure UX quality, SAIFAC integrates cleanly with preview environments (like Vercel/Netlify), allowing the PM to validate the _behavior_ and _feel_ of the feature, not just passing tests.                                        |

### Fulfilling Wants & Desires

| The Desire                | How SAIFAC Delivers                                                                                                                                                                                                           |
| :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Predictability**        | By automating the execution of bounded features and bugs, SAIFAC eliminates the 40% of sprint time wasted on miscommunications, spec revisions, and manual QA. It turns the backlog into a predictable assembly line.         |
| **Faster Time-to-Market** | Engineers are no longer bogged down writing boilerplate or manually testing edge cases. PMs can see their backlog cleared at machine speed.                                                                                 |
| **Transparency**          | SAIFAC integrates with Jira, Slack, and GitHub Projects. The PM can track a feature's exact stage on a Kanban board or receive automated Slack updates, getting a "Glass Pipeline" without tapping engineers on the shoulder. |

## 5. Ideal Workflow & Interactions

The PM sits at the very beginning of the SAIFAC pipeline. They are the initial catalyst, but they do NOT hand off directly to the AI.

1.  **The Brain Dump (Initiation):**
    - The PM writes a Jira ticket, Linear issue, or a `proposal.md` document. They outline the user problem, the desired behavior, and the acceptance criteria in plain English.
2.  **The IC Translation (Alignment):**
    - An engineer (IC) picks up the ticket and runs `saifac plan`. SAIFAC generates the technical `specification.md`.
    - The IC reviews and refines the specification, adding crucial nuances, system constraints, and edge cases that the PM might not be aware of. The PM does _not_ need to read this file; it is the source of truth for the engineer and the AI, but merely an implementation detail for the PM.
3.  **The Glass Pipeline (Execution):**
    - The IC triggers the SAIFAC coding agents. The PM steps back.
    - The PM monitors progress via their standard tools. SAIFAC pushes stage updates (Spec Generated -> Tests Written -> Coding -> PR Open) directly to Slack channels or moves tickets across the GitHub Project/Jira Kanban board.
4.  **Feature Acceptance:**
    - SAIFAC opens the PR, the IC reviews and merges it, and the PM tests the feature on a live staging environment. Because of the TDD enforcement and IC oversight, the failure rate at this stage drops dramatically.

## 6. Implications for the README & Landing Page

While the PM isn't the technical buyer or the daily CLI user, they are massive internal champions if they believe the tool will make their delivery predictable and get their features shipped faster.

- **Focus on Predictability:** PMs want to stop looking bad when sprints drag on. Emphasize how SAIFAC turns a chaotic backlog into a predictable assembly line.
- **Don't say:** "SAIFAC requires you to learn our proprietary DSL to define your features" OR "SAIFAC lets PMs bypass engineers and code directly."
- **Do say:** "Turn your product requirements into rigorously verified features. SAIFAC empowers your engineers to translate your plain-English proposals into rigorous technical specs and enforces them via automated testing—ensuring the team builds exactly what you asked for."
- **Highlight the "Glass Pipeline" & Integrations:** Emphasize that PMs get full transparency. Highlight integrations with GitHub Projects, Jira, and Slack to track items the AI is working on without micromanaging the engineering team.
