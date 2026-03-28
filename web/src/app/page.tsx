'use client';

import { motion } from 'framer-motion';
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Code2,
  GitMerge,
  Network,
  RefreshCcw,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { WaitlistModal } from '../components/WaitlistModal';
import { GITHUB_REPO } from '../constants';
import { track } from '../lib/analytics';
import { type SectionId } from '../lib/analytics/types';

// URLs
const GITHUB_AUTHOR = 'https://github.com/JuroOravec';
const GITHUB_CHANGELOG_URL = `${GITHUB_REPO}/releases`;
const GITHUB_DOCS_USAGE = `${GITHUB_REPO}/blob/main/docs/usage.md`;
const GITHUB_DOCS_SECURITY = `${GITHUB_REPO}/blob/main/docs/security.md`;
const LEASH_URL = 'https://github.com/strongdm/leash';
const CEDAR_POLICY_URL = 'https://www.cedarpolicy.com/';
const DOCS_URL = GITHUB_DOCS_USAGE; // TODO
const CLI_REFERENCE_URL = GITHUB_DOCS_USAGE; // TODO
const VSCODE_EXTENSION_URL = '#vscode'; // TODO
const VSCODE_EXTENSION_DOCS_URL = '#vscode'; // TODO

/**
 * Fires a `section_view` event once per session when a section scrolls into
 * view (threshold 20%). Uses a ref so the observer can be set up imperatively
 * against DOM ids without needing to modify individual section elements.
 */
function useSectionTracking(sectionIds: SectionId[]) {
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.id as SectionId;
          if (entry.isIntersecting && !firedRef.current.has(id)) {
            firedRef.current.add(id);
            track('section_view', { section: id });
          }
        });
      },
      { threshold: 0.2 },
    );

    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
    // sectionIds is a stable constant at every call site — empty deps array is intentional
  }, []);
}

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (delay = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, delay },
  }),
};

const ProveItCTA = () => {
  return (
    <div className="p-8 mx-auto mt-20 text-left rounded-xl bg-[#0a0f1a] border border-[#00ccff]/20 max-w-2xl">
      <h3 className="text-white font-bold text-lg mb-2">Want to see the Gauntlet in action?</h3>
      <p className="text-gray-400 text-sm mb-6 leading-relaxed">
        We are building a deterministic AI orchestrator. It forces the LLM to pass your linting
        rules, custom architectural checks, and hidden holdout tests before it ever attempts to open
        a PR.
      </p>
      <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-4 font-mono text-xs text-[#00FF66] space-y-1 mb-6">
        <div>
          <span className="text-gray-600">{'// '}</span>Dropping in a few weeks.
        </div>
        <div>
          <span className="text-gray-600">{'// '}</span>The Docker sandboxes and VSCode extension
          are baking.
        </div>
      </div>
      <a
        href={GITHUB_REPO}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-[#00ccff] hover:underline"
        onClick={() => track('outbound_click', { destination: 'github_repo' })}
      >
        Star the repo to get notified →
      </a>
    </div>
  );
};

export default function Home() {
  const [selectedPipelineNode, setSelectedPipelineNode] = useState(0);
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useSectionTracking([
    'gauntlet',
    'guarantee',
    'prove_it',
    'features',
    'deploy',
    'security',
    'reliability',
    'vscode',
    'cta',
  ]);

  const year = new Date().getFullYear();
  const copyrightYear = year === 2026 ? '2026' : `2026-${year}`;

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-gray-200 selection:bg-[#00FF66] selection:text-black overflow-x-hidden">
      <WaitlistModal open={waitlistOpen} onClose={() => setWaitlistOpen(false)} />
      {/* ─── NAVBAR ─────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 border-b border-[#333] bg-[#0F0F0F]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="flex items-center gap-2 hover:opacity-90 transition-opacity cursor-pointer"
          >
            <img src="/saifctl-icon-green.svg" alt="SaifCTL" className="w-6 h-6 shrink-0" />
            <span className="font-mono font-bold tracking-tight text-white">SaifCTL</span>
          </a>
          <div className="hidden md:flex items-center gap-6 text-sm">
            <a href="#gauntlet" className="text-gray-400 hover:text-white transition-colors">
              Features
            </a>
            <a href="#security" className="text-gray-400 hover:text-white transition-colors">
              Security
            </a>
            <a href="#deploy" className="text-gray-400 hover:text-white transition-colors">
              Get started
            </a>
            <a
              href={VSCODE_EXTENSION_URL}
              className="text-gray-400 hover:text-white transition-colors"
            >
              VSCode Extension
            </a>
            <a
              href={GITHUB_REPO}
              className="text-gray-400 hover:text-white transition-colors"
              target="_blank"
            >
              GitHub
            </a>
          </div>
          <button
            onClick={() => setWaitlistOpen(true)}
            className="px-4 py-1.5 bg-[#00FF66] hover:bg-[#00e05a] text-black font-medium rounded-md transition-colors font-mono text-sm"
          >
            Join Waitlist
          </button>
        </div>
      </nav>

      <main className="pt-24 pb-24">
        {/* ─── BLOCK 1: HERO ──────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 mb-28">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={fadeUp}
            className="text-center max-w-4xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1A1A1A] border border-[#333] mb-6">
              <span className="w-2 h-2 rounded-full bg-[#00FF66] animate-pulse" />
              <span className="text-xs font-mono text-gray-300">Alpha Available Soon</span>
            </div>

            <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-white mb-6 leading-tight">
              Safest open source harness for autonomous AI agents.
              <br />
              Agents can't{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-red-600">
                cheat
              </span>
              ,{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-red-600">
                leak
              </span>
              ,{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-red-600">
                wreak havoc
              </span>
              .
            </h1>

            <div className="text-lg md:text-xl text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed space-y-4">
              <p>
                Write feature specs, and let containerized agents iterate in a zero-trust sandbox
                until it passes your checks and tests.
              </p>
              <p className="text-base">
                SaifCTL is a spec-driven software factory.
                <br />
                Language-agnostic. Use with any agentic CLI. Safe by design.
              </p>
            </div>

            <div className="flex flex-col items-center gap-4">
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 flex-wrap">
                <button
                  onClick={() => setWaitlistOpen(true)}
                  className="px-6 py-3 bg-[#00FF66] hover:bg-[#00e05a] text-black font-bold rounded-md transition-colors"
                >
                  Join the Design Partner Waitlist
                </button>
                <a
                  href={GITHUB_REPO}
                  className="px-6 py-3 border border-[#333] hover:border-[#00FF66] text-white rounded-md transition-all flex items-center gap-2"
                  target="_blank"
                  onClick={() => track('outbound_click', { destination: 'github_repo' })}
                >
                  ★ Star on GitHub
                </a>
              </div>
            </div>
          </motion.div>
        </section>

        {/* ─── BLOCK 2: THE GAUNTLET ──────────────────────────────────────── */}
        <section id="gauntlet" className="bg-[#111] border-y border-[#333] py-24">
          <div className="max-w-6xl mx-auto px-6">
            <SectionLabel label="The Architecture" />
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-6 max-w-3xl">
              Code doesn't leave the sandbox until it survives the Gauntlet.
            </h2>
            <p className="text-gray-400 max-w-2xl mb-16 leading-relaxed">
              Most AI coding tools put you in the loop. You prompt, you review, you fix, you prompt
              again. <strong className="text-white">You are the quality gate.</strong>
              <br />
              <br />
              SaifCTL replaces that loop with a deterministic, multi-stage pipeline. The AI iterates
              inside a locked-down sandbox, getting rejected by{' '}
              <span className="font-bold text-white">your own rules</span> - linters, type-checkers,
              adversarial reviewer, and hidden tests - until the code actually works. You only see a
              PR when it has already passed everything.
            </p>

            {/* Pipeline */}
            <div className="overflow-visible sm:overflow-x-auto pb-4 pipeline-scroll">
              <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-0 sm:min-w-max mx-auto">
                {PIPELINE_NODES.map((node, i) => {
                  const isSelected = selectedPipelineNode === i;
                  return (
                    <div
                      key={i}
                      className="flex flex-col sm:flex-row items-center sm:items-center w-full sm:w-auto sm:self-stretch"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPipelineNode(i);
                          track('pipeline_step_click', { step: node.title });
                        }}
                        onMouseEnter={() => {
                          setSelectedPipelineNode(i);
                          track('pipeline_step_click', { step: node.title });
                        }}
                        className={`flex flex-col items-center gap-2 w-full sm:w-28 sm:h-full py-2 rounded-xl transition-all cursor-pointer text-left border-2 border-transparent hover:border-[#00FF66]/50 ${
                          isSelected
                            ? 'border-[#00FF66]/70 bg-[#00FF66]/5'
                            : 'hover:bg-[#1a1a1a]/50'
                        }`}
                      >
                        <div
                          className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-[#00FF66]/10 border-[#00FF66]/50'
                              : 'bg-[#1a1a1a] border border-[#333]'
                          }`}
                        >
                          {node.icon}
                        </div>
                        <span className="font-bold text-white text-xl sm:text-sm text-center">
                          {node.title}
                        </span>
                        <span className="text-gray-500 text-lg sm:text-xs text-center leading-snug sm:w-28 px-1">
                          {node.desc}
                        </span>
                        <div className="text-gray-400 text-sm leading-relaxed text-left px-4 sm:hidden">
                          {node.detail}
                        </div>
                      </button>
                      {i < PIPELINE_NODES.length - 1 && (
                        <div className="flex flex-col sm:flex-row items-center sm:mx-1 my-2 sm:my-0 sm:mb-10 sm:self-center">
                          <div className="w-px h-6 sm:w-6 sm:h-px bg-[#333]" />
                          <ChevronDown className="w-4 h-4 text-[#555] sm:hidden" />
                          <ChevronRight className="w-4 h-4 text-[#555] -ml-1 hidden sm:block" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Infobox for selected pipeline step (desktop only) */}
            <div className="hidden sm:block mt-8 p-6 border border-[#00FF66]/30 rounded-xl bg-[#0F1A10] max-w-3xl">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">{PIPELINE_NODES[selectedPipelineNode].icon}</span>
                <h3 className="font-bold text-white text-lg">
                  {PIPELINE_NODES[selectedPipelineNode].title}
                </h3>
              </div>
              <p className="text-gray-400 text-sm leading-relaxed">
                {PIPELINE_NODES[selectedPipelineNode].detail}
              </p>
            </div>

            <div className="mt-12 p-6 border border-[#333] rounded-xl bg-[#0F0F0F] max-w-3xl">
              <p className="text-gray-400 text-sm">
                <strong className="text-white">Every artifact is inspectable.</strong>{' '}
                <code className="text-[#00FF66]">proposal.md</code> →{' '}
                <code className="text-[#00FF66]">specification.md</code> →{' '}
                <code className="text-[#00FF66]">tests.json</code> → PR.
                <br />
                You can read, edit, or override any artifact before the next step begins.
              </p>
            </div>
          </div>
        </section>

        {/* ─── BLOCK 3: IRONCLAD GUARANTEE ────────────────────────────────── */}
        <section
          id="guarantee"
          className="py-24 mb-32 bg-gradient-to-b from-[#0a1a0f] to-[#0F0F0F] border-y border-[#00FF66]/20"
        >
          <div className="max-w-4xl mx-auto px-6 text-center">
            <SectionLabel label="The Guarantee" green />
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-16">
              Three things SaifCTL guarantees. <span className="text-[#00FF66]">Mechanically.</span>
            </h2>
            <div className="grid md:grid-cols-3 gap-8">
              {GUARANTEES.map((g, i) => (
                <motion.div
                  key={i}
                  variants={fadeUp}
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true }}
                  custom={i * 0.15}
                  className="p-6 border border-[#00FF66]/20 rounded-xl bg-[#0F1A10]"
                >
                  <div className="text-3xl mb-4">{g.icon}</div>
                  <h3 className="font-bold text-white text-lg mb-3">{g.title}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{g.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── BLOCK 4: PROVE IT ──────────────────────────────────────── */}
        <section id="prove_it" className="max-w-6xl mx-auto px-6 mb-32">
          {/* Hero Terminal Visual */}
          <div className="mt-20">
            <p className="text-gray-400 max-w-3xl leading-relaxed mx-auto">
              <strong className="text-white">The proof is in the work:</strong>
            </p>
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="mt-4 relative rounded-xl border border-[#333] bg-[#111] overflow-hidden shadow-2xl glow-green mx-auto max-w-3xl"
            >
              {/* Terminal chrome */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#333] bg-[#1a1a1a]">
                <span className="w-3 h-3 rounded-full bg-red-500/70" />
                <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
                <span className="w-3 h-3 rounded-full bg-green-500/70" />
                <span className="ml-2 font-mono text-xs text-gray-500">
                  saifctl feat run -n rate-limiting
                </span>
              </div>
              <div className="p-6 font-mono text-sm space-y-3">
                <TerminalLine
                  delay={0.5}
                  prefix="ℹ"
                  prefixColor="text-blue-400"
                  text="Starting SaifCTL run · feature: rate-limiting · agent: claude-code"
                />
                <TerminalLine
                  delay={0.9}
                  prefix="↳"
                  prefixColor="text-gray-500"
                  text="Attempt 1/3 — sandbox provisioned · Cedar policies applied"
                />
                <TerminalLine
                  delay={1.4}
                  prefix="🔴"
                  prefixColor="text-red-400"
                  text="FAILED — Holdout tests: race condition detected in test_concurrent_requests"
                  color="text-red-300"
                />
                <TerminalLine
                  delay={1.8}
                  prefix="↳"
                  prefixColor="text-gray-500"
                  text="Attempt 2/3 — container reset · state wiped · feedback injected"
                />
                <TerminalLine
                  delay={2.3}
                  prefix="🔴"
                  prefixColor="text-red-400"
                  text="FAILED — memory_profiler_threshold exceeded under load"
                  color="text-red-300"
                />
                <TerminalLine
                  delay={2.7}
                  prefix="↳"
                  prefixColor="text-gray-500"
                  text="Attempt 3/3 — container reset · state wiped · feedback injected"
                />
                <TerminalLine
                  delay={3.2}
                  prefix="✅"
                  prefixColor="text-[#00FF66]"
                  text="PASSED — All 14 tests green. Gate ✅  Reviewer ✅  Holdout Tests ✅"
                  color="text-[#00FF66]"
                />
                <TerminalLine
                  delay={3.6}
                  prefix="→"
                  prefixColor="text-[#00FF66]"
                  text="Opening PR · agent: saifctl-agent[run-a1b2c3] · cost: $1.42 · 43 min"
                  color="text-gray-300"
                />
              </div>
            </motion.div>
          </div>

          {/* saifctl prove CTA */}
          <ProveItCTA />
        </section>

        {/* ─── BLOCK 4: FEATURE GRID ──────────────────────────────────────── */}
        <section id="features" className="max-w-6xl mx-auto px-6 mb-32">
          <SectionLabel label="Feature Grid" />
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Built for every layer of your engineering org
          </h2>
          <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
            SaifCTL isn't just a tool for one person. It's infrastructure for the whole team - the
            engineer who uses it daily, the manager who relies on it for predictable delivery, the
            CTO who needs to know it's secure, and the security team that has to sign off on it.
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            {FEATURE_CARDS.map((card, i) => (
              <motion.div
                key={i}
                variants={fadeUp}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                custom={i * 0.1}
                className="p-8 border border-[#333] rounded-xl bg-[#111] hover:border-[#00FF66]/40 transition-all"
              >
                <div className="flex items-center gap-3 mb-4">
                  <card.Icon className="w-6 h-6 text-[#00FF66]" />
                  <h3 className="font-bold text-white text-lg">{card.title}</h3>
                </div>
                <div className="space-y-4">
                  {card.body.map((block, j) => {
                    if (block.type === 'text') {
                      return (
                        <p
                          key={j}
                          className="text-gray-400 leading-relaxed text-sm"
                          style={{ whiteSpace: 'pre-line' }}
                        >
                          {block.content}
                        </p>
                      );
                    }
                    if (block.type === 'code') {
                      const lines = Array.isArray(block.content) ? block.content : [block.content];
                      return (
                        <div
                          key={j}
                          className="bg-[#0F0F0F] border border-[#333] rounded-md p-4 font-mono text-xs text-[#00FF66] space-y-1"
                        >
                          {lines.map((line, k) => (
                            <div key={k}>
                              <span className="text-gray-600">$ </span>
                              {line}
                            </div>
                          ))}
                        </div>
                      );
                    }
                    if (block.type === 'bullets') {
                      const items = block.content;
                      return (
                        <ul key={j} className="space-y-2">
                          {items.map((b, k) => (
                            <li key={k} className="flex items-start gap-2 text-sm text-gray-400">
                              <CheckCircle className="w-4 h-4 text-[#00FF66] mt-0.5 shrink-0" />
                              {b}
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    return null;
                  })}
                </div>
              </motion.div>
            ))}
          </div>
        </section>

        {/* ─── BLOCK 5: DEPLOYMENT FLEXIBILITY ───────────────────────────── */}
        <section id="deploy" className="bg-[#111] border-y border-[#333] py-24 mb-32">
          <div className="max-w-6xl mx-auto px-6">
            <SectionLabel label="Deployment" />
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Where you need it. How you need it.
            </h2>
            <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
              SaifCTL is designed to start on your laptop and scale to your entire org. Adopt one
              ticket at a time, or deploy a full fleet. The factory runs anywhere your Docker daemon
              does.
            </p>
            <div className="grid md:grid-cols-3 gap-6">
              {DEPLOY_TIERS.map((tier, i) => (
                <motion.div
                  key={i}
                  variants={fadeUp}
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true }}
                  custom={i * 0.1}
                  className="p-8 rounded-xl border border-[#333] bg-[#111] hover:border-[#00FF66]/40 transition-all"
                >
                  <div className="text-3xl mb-3">{tier.icon}</div>
                  <h3 className="font-bold text-white text-xl mb-1">{tier.name}</h3>
                  <p className="text-[#00FF66] text-sm font-mono mb-4">{tier.subtitle}</p>
                  <p className="text-gray-400 text-sm leading-relaxed mb-6">{tier.body}</p>
                  {tier.openWaitlist ? (
                    <button
                      onClick={() => setWaitlistOpen(true)}
                      className="text-sm text-[#00FF66] hover:underline flex items-center gap-1"
                    >
                      {tier.cta} <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <a
                      href={tier.href ?? '#'}
                      {...(tier.href?.startsWith('http') && {
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      })}
                      className="text-sm text-[#00FF66] hover:underline flex items-center gap-1"
                    >
                      {tier.cta} <ChevronRight className="w-4 h-4" />
                    </a>
                  )}
                </motion.div>
              ))}
            </div>
            <p className="mt-10 text-sm text-gray-500 text-center max-w-3xl mx-auto italic">
              In all three tiers, the agents run in ephemeral containers, secrets are never exposed
              to the agent workspace, and every run is signed with a verifiable Agent Identity.
            </p>
          </div>
        </section>

        {/* ─── BLOCK 6: ZERO-TRUST SECURITY ───────────────────────────────── */}
        <section id="security" className="max-w-6xl mx-auto px-6 mb-32">
          <SectionLabel label="Security" />
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            SaifCTL treats every AI agent as an insider threat.{' '}
            <span className="text-gray-400">So should you.</span>
          </h2>
          <p className="text-gray-400 max-w-2xl mb-4 leading-relaxed">
            An autonomous coding agent has the same access as a developer with a grudge. It can read
            your secrets, exfiltrate your codebase, install malicious dependencies, and rewrite test
            files to fake a passing build - all while looking like it's just doing its job.
          </p>
          <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
            The industry has responded with vibes. <em>"We sandboxed it. We trust the model."</em>{' '}
            <br />
            <br />
            SaifCTL responded with architecture. Every security property below is enforced in code.
          </p>
          <SecurityTable rows={SECURITY_ROWS} />
          <p className="mt-8 text-sm text-gray-500">
            SaifCTL is fully open source. Read the Dockerfiles, audit the Cedar policies, inspect
            every data flow, and verify these properties before deploying a single agent.{' '}
            <a
              href={GITHUB_DOCS_SECURITY}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#00FF66] hover:underline"
              onClick={() => track('outbound_click', { destination: 'security_docs' })}
            >
              Read the Full Security Architecture →
            </a>
          </p>
        </section>

        {/* ─── BLOCK 7: RELIABILITY & CONTROL ─────────────────────────────── */}
        <section id="reliability" className="bg-[#111] border-y border-[#333] py-24 mb-32">
          <div className="max-w-6xl mx-auto px-6">
            <SectionLabel label="Reliability" />
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              The guardrails that let you actually sleep at night.
            </h2>
            <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
              Security keeps the attacker out. Reliability means an agent stuck in a loop won't burn
              through your budget. SaifCTL takes care of both.
            </p>
            <SecurityTable
              rows={RELIABILITY_ROWS}
              colHeaders={['The Operational Risk', 'How SaifCTL Handles It']}
            />
          </div>
        </section>

        {/* ─── BLOCK 8: VSCODE EXTENSION ──────────────────────────────────── */}
        <section id="vscode" className="max-w-6xl mx-auto px-6 mb-32">
          <SectionLabel label="VSCode Extension" />
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Your entire AI factory, without leaving your editor.
          </h2>
          <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
            The SaifCTL CLI is powerful. But you live in your IDE. Context-switching to a terminal
            to check on a running agent, triage a failed run, or kick off a debug session breaks
            your flow. The SaifCTL VSCode Extension brings the entire factory into your sidebar. No
            terminal required.
          </p>

          {/* Screenshot placeholder */}
          <div className="w-full rounded-xl border border-[#333] bg-[#111] overflow-hidden mb-12 glow-green">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#333] bg-[#1a1a1a]">
              <span className="w-3 h-3 rounded-full bg-red-500/70" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
              <span className="w-3 h-3 rounded-full bg-green-500/70" />
              <span className="ml-2 text-xs text-gray-500 font-mono">
                VS Code — safe-ai-factory
              </span>
            </div>
            <div className="flex min-h-[400px]">
              {/* Activity bar */}
              <div className="w-12 bg-[#1a1a1a] border-r border-[#333] flex flex-col items-center py-4 gap-4">
                <div className="w-6 h-6 bg-[#00FF66] rounded-sm flex items-center justify-center text-black font-bold text-xs">
                  S
                </div>
                <div className="w-5 h-5 rounded bg-[#333]" />
                <div className="w-5 h-5 rounded bg-[#333]" />
                <div className="w-5 h-5 rounded bg-[#333]" />
              </div>
              {/* Sidebar */}
              <div className="w-64 bg-[#161616] border-r border-[#333] p-4 font-mono text-xs">
                <div className="text-gray-500 uppercase text-[10px] tracking-widest mb-3">
                  SaifCTL — Features
                </div>
                <div className="space-y-2">
                  {['rate-limiting', 'auth-refresh', 'webhook-retry'].map((feat, i) => (
                    <div key={i} className="group">
                      <div className="flex items-center justify-between text-gray-300 hover:text-white cursor-pointer py-1">
                        <span>📁 {feat}</span>
                        {i === 0 && <span className="text-[#00FF66] text-[10px]">● running</span>}
                        {i === 1 && <span className="text-red-400 text-[10px]">● failed</span>}
                        {i === 2 && <span className="text-gray-500 text-[10px]">● idle</span>}
                      </div>
                      {i === 0 && (
                        <div className="ml-4 mt-1 flex gap-2">
                          <button className="px-2 py-0.5 bg-[#00FF66]/10 text-[#00FF66] rounded text-[10px]">
                            ▶ Run
                          </button>
                          <button className="px-2 py-0.5 bg-[#333] text-gray-300 rounded text-[10px]">
                            🐛 Debug
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="text-gray-500 uppercase text-[10px] tracking-widest mt-6 mb-3">
                  Live Log — rate-limiting
                </div>
                <div className="space-y-1 text-[10px]">
                  <div className="text-gray-500">Attempt 1/3 — sandbox provisioned</div>
                  <div className="text-red-400">🔴 FAILED — race condition in test_concurrent</div>
                  <div className="text-gray-500">Attempt 2/3 — container reset</div>
                  <div className="text-[#00FF66] animate-pulse">✅ PASSED — 14 tests green</div>
                </div>
              </div>
              {/* Editor placeholder */}
              <div className="flex-1 flex items-center justify-center text-gray-600 font-mono text-sm flex-col gap-2">
                <Code2 className="w-10 h-10 opacity-30" />
                <span className="opacity-50 text-xs">[ screenshot / recording placeholder ]</span>
                <span className="opacity-30 text-xs">src: x_web/workspace.png or demo video</span>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-8">
            {VSCODE_FEATURES.map((f, i) => (
              <motion.div
                key={i}
                variants={fadeUp}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                custom={i * 0.1}
                className="p-6 border border-[#333] rounded-xl bg-[#111]"
              >
                <div className="text-2xl mb-3">{f.icon}</div>
                <h3 className="font-bold text-white mb-2">{f.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{f.body}</p>
              </motion.div>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <a
              href={VSCODE_EXTENSION_URL}
              className="px-5 py-2.5 bg-[#00FF66] hover:bg-[#00e05a] text-black font-medium rounded-md transition-colors text-sm"
              onClick={() => setWaitlistOpen(true)}
            >
              Get Notified When It Ships
            </a>
            <a
              href={VSCODE_EXTENSION_DOCS_URL}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              View Extension Docs →
            </a>
          </div>
        </section>

        {/* ─── BLOCK 9: THE GLASS PIPELINE ────────────────────────────────── */}
        <section id="glass-pipeline" className="bg-[#111] border-y border-[#333] py-24 mb-32">
          <div className="max-w-6xl mx-auto px-6">
            <SectionLabel label="Transparency" />
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
              SaifCTL shows its work. <span className="text-gray-400">That's the point.</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mb-4 leading-relaxed">
              Engineers don't trust AI tools that work perfectly on the first try. Neither do we.
            </p>
            <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
              What you actually want from an AI agent isn't magic — it's{' '}
              <strong className="text-white">evidence</strong>. You want to know what it tried, why
              it failed, how it corrected itself, and what exactly it proved before opening a PR.
              SaifCTL attaches a full run log to every PR it opens. To prove it did the work.
            </p>

            {/* PR Mockup */}
            <div className="rounded-xl border border-[#30363d] bg-[#0d1117] overflow-hidden mb-12 font-mono text-sm">
              {/* PR header */}
              <div className="border-b border-[#30363d] p-6">
                <div className="flex items-start gap-3">
                  <GitMerge className="w-5 h-5 text-[#00FF66] mt-1 shrink-0" />
                  <div>
                    <h3 className="text-white font-bold text-base">
                      feat: implement user rate limiting
                    </h3>
                    <p className="text-[#8b949e] text-xs mt-1">
                      opened by{' '}
                      <code className="text-[#00ccff] bg-[#00ccff]/10 px-1 rounded">
                        saifctl-agent[run-a1b2c3]
                      </code>{' '}
                      · 3 commits · 14 tests added
                    </p>
                  </div>
                </div>
              </div>
              {/* Run log */}
              <div className="p-6 text-[#8b949e] text-xs space-y-4">
                <div>
                  <span className="text-white font-bold">Spec Check:</span> Passed 4/4 functional
                  requirements.
                </div>
                <div>
                  <span className="text-white font-bold block mb-2">The Factory Run Log:</span>
                  <div className="space-y-3 pl-4 border-l border-[#30363d]">
                    <RunAttempt
                      n={1}
                      status="fail"
                      detail="Coder Agent implemented Redis sliding window. Holdout tests: race condition in test_concurrent_requests. Concurrent writes not atomic. Container reset."
                    />
                    <RunAttempt
                      n={2}
                      status="fail"
                      detail="Agent added distributed lock. Gate ✅  Reviewer ✅. Failure: memory_profiler_threshold — lock introduced memory leak under load. Container reset."
                    />
                    <RunAttempt
                      n={3}
                      status="pass"
                      detail="Agent simplified implementation. Removed redundant lock layer. All 14 tests green. Gate: ✅  Reviewer: ✅  Holdout Tests: ✅"
                    />
                  </div>
                </div>
                <div className="border-t border-[#30363d] pt-4 text-[#8b949e]">
                  Agent Identity: <code className="text-[#00ccff]">saifctl-agent[run-a1b2c3]</code>{' '}
                  · Runtime: 43 min · API cost: $1.42 · Full log:{' '}
                  <code className="text-[#00FF66]">saifctl-run-log.md</code>
                </div>
              </div>
            </div>

            <p className="text-gray-400 max-w-2xl mb-12 leading-relaxed">
              Yes, SaifCTL took 43 minutes and failed twice before getting it right. That's not a
              bug — that's the system doing its job. It found a race condition and a memory leak
              before they reached your PR queue.{' '}
              <strong className="text-white">
                That's what deterministic verification looks like.
              </strong>{' '}
              It's slower than a magic button. It's faster than your current review cycle.
            </p>
          </div>
        </section>

        {/* ─── BLOCK 10: FINAL CTA ─────────────────────────────────────────── */}
        <section id="cta" className="max-w-4xl mx-auto px-6 mb-32 text-center">
          <SectionLabel label="Get Started" center />
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-6">
            Ready to stop reviewing broken AI PRs?
          </h2>
          <p className="text-xl text-gray-400 mb-12 max-w-2xl mx-auto leading-relaxed">
            Your team is spending hours per week reviewing code that never should have reached the
            PR queue - wrong architecture, alien patterns, missing edge cases, failing tests caught
            too late.
            <br />
            <br />
            SaifCTL enforces rigor before the PR exists.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 flex-wrap">
            <button
              onClick={() => setWaitlistOpen(true)}
              className="px-8 py-4 bg-[#00FF66] hover:bg-[#00e05a] text-black font-bold rounded-md transition-colors text-lg"
            >
              Join the Design Partner Waitlist
            </button>
            <a
              href={GITHUB_REPO}
              target="_blank"
              className="px-8 py-4 border border-[#333] hover:border-[#00FF66] text-white rounded-md transition-all text-lg"
              onClick={() => track('outbound_click', { destination: 'github_repo' })}
            >
              ★ Star on GitHub
            </a>
          </div>

          {/* saifctl prove CTA */}
          <ProveItCTA />
        </section>
      </main>

      {/* ─── FOOTER ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-[#333] py-16">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <img src="/saifctl-icon-green.svg" alt="SaifCTL" className="w-6 h-6 shrink-0" />
                <span className="font-mono font-bold text-white">SaifCTL</span>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed mb-4">
                SaifCTL is a spec-driven software factory. Open source. Language-agnostic. Use with
                any agentic CLI. Safe by design.
              </p>
              <a
                href={GITHUB_REPO}
                className="text-[#00FF66] text-sm hover:underline"
                target="_blank"
              >
                GitHub →
              </a>
            </div>
            <div>
              <h4 className="font-bold text-white text-sm mb-4">Learn More</h4>
              <ul className="space-y-2 text-sm text-gray-500">
                <li>
                  <a
                    href={DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    Docs
                  </a>
                </li>
                <li>
                  <a
                    href={CLI_REFERENCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    CLI Reference
                  </a>
                </li>
                <li>
                  <a
                    href={GITHUB_CHANGELOG_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    Changelog
                  </a>
                </li>
                <li>
                  <a
                    href={GITHUB_REPO}
                    className="hover:text-white transition-colors"
                    target="_blank"
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a href="/privacy" className="hover:text-white transition-colors">
                    Privacy Policy
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-[#333] pt-8 text-center text-xs text-gray-600 font-mono">
            © {copyrightYear} Made by{' '}
            <a href={GITHUB_AUTHOR} target="_blank" className="text-[#00FF66] hover:underline">
              Juro Oravec
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── SUB-COMPONENTS ──────────────────────────────────────────────────────────

function SectionLabel({
  label,
  green,
  center,
}: {
  label: string;
  green?: boolean;
  center?: boolean;
}) {
  return (
    <div className={`flex ${center ? 'justify-center' : ''} mb-3`}>
      <span
        className={`inline-flex items-center gap-1.5 text-xs font-mono tracking-widest uppercase px-2 py-1 rounded ${green ? 'text-[#00FF66] bg-[#00FF66]/10' : 'text-gray-500 bg-[#1a1a1a]'}`}
      >
        {label}
      </span>
    </div>
  );
}

function TerminalLine({
  delay,
  prefix,
  prefixColor,
  text,
  color = 'text-gray-400',
}: {
  delay: number;
  prefix: string;
  prefixColor: string;
  text: string;
  color?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="flex items-start gap-2"
    >
      <span className={`shrink-0 ${prefixColor}`}>{prefix}</span>
      <span className={color}>{text}</span>
    </motion.div>
  );
}

function SecurityTable({
  rows,
  colHeaders = ['The Attack Vector', 'How SaifCTL Physically Prevents It'],
}: {
  rows: { threat: ReactNode; defense: ReactNode }[];
  colHeaders?: [string, string];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#333]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#333]">
            <th className="text-left p-4 text-gray-500 font-mono text-xs uppercase tracking-widest bg-[#1a1a1a] w-2/5">
              {colHeaders[0]}
            </th>
            <th className="text-left p-4 text-gray-500 font-mono text-xs uppercase tracking-widest bg-[#1a1a1a]">
              {colHeaders[1]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={`border-b border-[#333] last:border-b-0 ${i % 2 === 0 ? 'bg-[#0F0F0F]' : 'bg-[#111]'}`}
            >
              <td className="p-4 text-gray-300 align-top leading-relaxed">{row.threat}</td>
              <td className="p-4 text-gray-400 align-top leading-relaxed">{row.defense}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunAttempt({ n, status, detail }: { n: number; status: 'pass' | 'fail'; detail: string }) {
  return (
    <div>
      <span className={`font-bold ${status === 'pass' ? 'text-[#00FF66]' : 'text-red-400'}`}>
        {status === 'pass' ? '✅' : '🔴'} Attempt {n}/3 {status === 'pass' ? 'PASSED' : 'FAILED'}
      </span>
      <p className="text-[#8b949e] mt-1">{detail}</p>
    </div>
  );
}

// ─── DATA ─────────────────────────────────────────────────────────────────────

const PIPELINE_NODES = [
  {
    icon: '📝',
    title: 'Proposal',
    desc: (
      <>
        Plain English.
        <br />
        An unstructured idea.
        <br />A Jira ticket.
      </>
    ),
    detail:
      'Start with your raw intent - a GitHub issue, a Jira ticket, or just a loose description of the problem. SaifCTL reads it, then hands it to the Spec Agent. You can edit or override the proposal before the next step runs.',
  },
  {
    icon: '🔍',
    title: 'Spec Agent',
    desc: 'Reads your codebase. Learns your patterns. Generates spec + tests.',
    detail: (
      <>
        The Spec Agent reads your repo to understand your conventions, existing patterns, and tech
        stack. It produces a structured spec and generates the actual TDD tests.
        <br />
        <code className="text-[#00FF66]">proposal.md</code> →{' '}
        <code className="text-[#00FF66]">specification.md</code> →{' '}
        <code className="text-[#00FF66]">tests.json</code> →{' '}
        <code className="text-[#00FF66]">Test files</code>
        <br />
        You review and edit both the spec and the tests before the coder sees anything. This is your
        last cheap checkpoint.
      </>
    ),
  },
  {
    icon: '🐳',
    title: 'Sandbox',
    desc: 'Agent writes code in an ephemeral Docker container. No host access.',
    detail: (
      <>
        The coder agent runs inside a{' '}
        <a href={LEASH_URL} target="_blank" className="text-[#00FF66] hover:underline">
          Leash
        </a>
        -controlled Docker container. The agent is instructed to complete your new feature. It
        receives a copy of the codebase and is given a free reign.
        <br />
        <br />
        Once the agent finishes, its output is extracted as a plain-text git diff and sent to the
        Gate.
        <br />
        <br />
        After every iteration the container is destroyed completely. No backdoors can survive
        between cycles.
      </>
    ),
  },
  {
    icon: '🚧',
    title: 'The Gate',
    desc: 'Your linters. Your type-checkers. Your rules, enforced.',
    detail: (
      <>
        First line of defense: Agent's code must pass your own static tooling - linters,
        type-checkers, formatters, custom scripts (e.g. TypeScript, ESLint, coverage, dead code
        analysis, etc.).
        <br />
        <br />
        Configured via <code className="text-[#00FF66]">gate.sh</code> in your repository.
        <br />
        <br />
        If the Gate fails, the diff is rejected and the agent is given structured feedback to fix
        the issue.
        <br />
        <br />
        The agent cannot modify the gate scripts.
      </>
    ),
  },
  {
    icon: '🧠',
    title: 'The Reviewer',
    desc: 'Adversarial AI. Rejects alien code. Enforces your idioms.',
    detail: (
      <>
        Second line of defense: An AI reviewer goes through the code and decides whether the feature
        was implemented correctly.
        <br />
        <br />
        It also checks the diff for "AI-isms": hardcoded magic values, bloated abstractions, style
        drift, or patterns that don't match your codebase.
        <br />
        <br />
        If the reviewer finds any issues, the diff is rejected and the agent is given structured
        feedback to fix the issue.
        <br />
        <br />
        The reviewer cannot modify the codebase. Reviewer's suggestions are filtered for false
        positives.
      </>
    ),
  },
  {
    icon: '⚖️',
    title: 'Holdout Tests',
    desc: "Hidden tests. Agent can't see them. Can't fake a pass.",
    detail: (
      <>
        Third line of defense: Test the agent's code against a hidden set of tests.
        <br />
        <br />
        Every feature has two test sets:
        <ul className="list-disc list-inside">
          <li>Public tests - visible to the agent; cannot modify them.</li>
          <li>Hidden holdout tests - agent never sees them; cannot modify them.</li>
        </ul>
        <br />
        The agent cannot hardcode expected outputs to fake a pass: it has to write real code.
        <br />
        <br />
        If the holdout tests fail, the diff is rejected and the agent is given structured feedback
        to fix the issue.
      </>
    ),
  },
  {
    icon: '✅',
    title: 'The PR',
    desc: 'Clean. Verified. Signed by Agent Identity.',
    detail: (
      <>
        A PR is only opened when the diff has cleared every prior stage: Gate, Reviewer, and Holdout
        tests.
        <br />
        <br />
        Commits are signed with a dedicated Agent Identity (
        <code className="text-[#00FF66]">saifctl-agent[run-id]</code>).
        <br />
        <br />
        The full run log (attempts, failures, feedback loops) is attached to the PR description so
        reviewers can see exactly what the agent did.
      </>
    ),
  },
];

const GUARANTEES = [
  {
    icon: '🎯',
    title: 'The AI builds exactly what you asked for.',
    body: 'It is locked in a loop and physically cannot stop until your TDD tests pass.',
  },
  {
    icon: '🛡️',
    title: "The AI can't break previously-built features.",
    body: 'All features built with SaifCTL are protected by tests the AI cannot modify. Regressions are impossible.',
  },
  {
    icon: '🔒',
    title: 'The AI touches nothing outside its sandbox.',
    body: (
      <>
        Your codebase, your secrets, your machine. All are safe.
        <br />
        AI only sees files tracked by git.
      </>
    ),
  },
];

const FEATURE_CARDS = [
  {
    Icon: Zap,
    title: 'Focus on architectural design. Let the agent do the grinding.',
    body: [
      {
        type: 'text' as const,
        content: (
          <>
            AI agents should speed up your workflow, not leave you with an indecipherable black box.
            <br />
            <br />
            When things go wrong, most tools leave you a cryptic terminal error and a broken state
            you have to manually untangle.
            <br />
            <br />
            SaifCTL does the opposite: when an agent hits its limit, it saves the exact state - the
            partial diff, the last error, the stack trace.
          </>
        ),
      },
      { type: 'code' as const, content: ['saifctl run debug <run-id>'] },
      {
        type: 'text' as const,
        content: (
          <>
            A VSCode Remote Container opens with everything intact. You fix the blocker and resume.
          </>
        ),
      },
    ],
  },
  {
    Icon: Network,
    title: "You own delivery. You can't own what you can't see.",
    body: [
      {
        type: 'text' as const,
        content: (
          <>
            If your team runs agents on their laptops, you have no visibility. Shadow compute.
            Unknown API spend. Rogue loops burning budget over the weekend while nobody's watching.
            <br />
            <br />
            The solution: SaifCTL's centralized orchestration plane.
          </>
        ),
      },
      {
        type: 'bullets' as const,
        content: [
          'Live terminal logs from every active agent run across the org',
          'API spend per team, per feature, per user - mapped to your org structure',
          'Agent iteration limits - a stuck agent halts automatically',
        ],
      },
    ],
  },
  {
    Icon: RefreshCcw,
    title: "Don't bet on one tool. Own the workflow instead.",
    body: [
      {
        type: 'text' as const,
        content:
          "A new AI tool arrives every month. When a better one drops, you're either locked in, or you're rebuilding your workflow from scratch.\n\nSaifCTL is a verification engine, not a coding agent. Swap agents and models with ease:",
      },
      {
        type: 'code' as const,
        content: ['saifctl run --agent=claude-code', 'saifctl run --model=claude-sonnet-4-6'],
      },
      {
        type: 'text' as const,
        content: (
          <>
            SaifCTL is language-agnostic. Reuse SaifCTL across projects or teams without changing
            your AI workflow.
          </>
        ),
      },
    ],
  },
  {
    Icon: ShieldCheck,
    title: 'You need to trust what runs in your infrastructure.',
    body: [
      {
        type: 'text' as const,
        content: (
          <>
            Most autonomous agents have full access to the developer's machine by default. They can
            read
            <code className="text-[#00FF66]">.env</code> files, access{' '}
            <code className="text-[#00FF66]">~/.aws</code> credentials, or call external endpoints.
            And these tools ask you to trust them...
            <br />
            <br />
            SaifCTL assumes you won't. And it's built accordingly.
          </>
        ),
      },
      {
        type: 'bullets' as const,
        content: [
          'Ephemeral Docker containers governed by Cedar access policies',
          'Agent physically blocked from reading secrets or hidden tests',
          'No persistent state, no backdoors, no lingering access',
        ],
      },
      {
        type: 'text' as const,
        content:
          'SaifCTL is open source. Audit the Dockerfiles, review the Cedar policies, inspect the data flow.',
      },
    ],
  },
];

const DEPLOY_TIERS = [
  {
    icon: '💻',
    name: 'Local CLI',
    subtitle: 'Start on your laptop',
    body: 'Open source. Runs on your laptop via Docker Compose. Zero infrastructure overhead. Zero config beyond an API key. Pick a ticket, write a proposal, let it run while you work on something else.',
    cta: 'Get Notified When It Ships',
    href: GITHUB_REPO,
    openWaitlist: true,
  },
  {
    icon: '🏢',
    name: 'Self-Hosted VPC',
    subtitle: 'Full control inside your own infrastructure',
    body: 'Deploy the SaifCTL Control Server inside your own infrastructure via Kubernetes (Helm). Your codebase never leaves your network. Full identity-aware cost attribution, RBAC, org-wide budget caps, and a centralized fleet dashboard.',
    cta: 'Join Design Partner Waitlist',
    href: undefined,
    openWaitlist: true,
  },
  {
    icon: '☁️',
    name: 'Managed Cloud',
    subtitle: 'Zero infrastructure overhead',
    body: 'We host the orchestration. You bring your own API keys. Get the full enterprise control plane - fleet observability, budget caps, team management - without standing up a Kubernetes cluster.',
    cta: 'Join Design Partner Waitlist',
    href: undefined,
    openWaitlist: true,
  },
];

const codeCls = 'text-[#00FF66] bg-[#00FF66]/10 px-1 rounded';

const SECURITY_ROWS: { threat: ReactNode; defense: ReactNode }[] = [
  {
    threat:
      'Agent escapes the sandbox via shared memory, Docker socket access, or by leaving malicious state that persists between iterations',
    defense: (
      <>
        Five independent isolation layers:
        <ol className="list-inside mt-2 space-y-1">
          <li>
            (1) The agent runs in a Docker container with network and filesystem access controlled
            by{' '}
            <a href={LEASH_URL} target="_blank" className="text-[#00FF66] hover:underline">
              Leash
            </a>
            .
          </li>
          <li>
            (2) Agent receives only a copy of the codebase. Your secrets, and
            <code className={codeCls}>.git</code> and hidden test files are never exposed to th
            eagent.
          </li>
          <li>
            (3) The agent's output is extracted as a plain-text{' '}
            <code className={codeCls}>git diff</code>. Unsafe changes (e.g. modifications to tests)
            are stripped from the git diff before processing.
          </li>
          <li>
            (4) After every iteration, the coder container and all ephemeral services are destroyed
            entirely.
          </li>
          <li>
            (5) During testing, the test runner and agent's code changes are in two separate
            containers and communicate over HTTP only. There is no shared memory and no Docker
            socket access between the coder and the test runner.
          </li>
        </ol>
      </>
    ),
  },
  {
    threat:
      "Agent uses prompt injection to manipulate SaifCTL's own AI components into approving the code",
    defense: (
      <>
        The agent never controls any input that reaches SaifCTL's internal AI agents. Neither code
        changes nor test failures are forwarded to SaifCTL's AI agents. The coding agent cannot
        inject instructions into any part of the pipeline it doesn't own.
        <br />
        <br />
        The only exception is the AI Reviewer. The Reviewer checks for semantic correctness of the
        code. It lives directly in the agent's container and reads agent's code. Bypassing Reviewer
        does NOT guarantee success.
      </>
    ),
  },
  {
    threat: 'Agent modifies or deletes test files to force a passing build (reward hacking)',
    defense: (
      <>
        Every SaifCTL feature has two test sets:
        <ol className="list-inside list-disc">
          <li>Public - The agent can see public tests but cannot modify them.</li>
          <li>Hidden - The agent never sees the hidden tests.</li>
        </ol>
        <br />
        You write these tests yourself. Agent never writes its own tests.
      </>
    ),
  },
  {
    threat: (
      <>
        Agent reads <code className={codeCls}>~/.aws</code>, <code className={codeCls}>.env</code>,
        or SSH keys and leaks credentials
      </>
    ),
    defense:
      "Secrets are never exposed to the agent. The agent can see only source-controlled files in the project directory. The agent's container cannot see the host filesystem at all.",
  },
  {
    threat:
      'Agent exfiltrates proprietary source code by making outbound HTTP calls to an attacker-controlled endpoint',
    defense: (
      <>
        Preventable in single step: Define network access with{' '}
        <a href={CEDAR_POLICY_URL} target="_blank" className="text-[#00FF66] hover:underline">
          Cedar
        </a>{' '}
        policies. Every outbound connection attempt is intercepted and logged. Traffic to unapproved
        endpoints is blocked at the syscall level.
      </>
    ),
  },
  {
    threat:
      'Agent hallucinates a package name; an attacker has typosquatted it on npm; malware is installed silently',
    defense: (
      <>
        Preventable in 3 steps:
        <ol className="list-inside">
          <li>
            (1) Configure <code className={codeCls}>.npmrc</code> to point to your internal
            registry.
          </li>
          <li>
            (2) Set{' '}
            <a href={CEDAR_POLICY_URL} target="_blank" className="text-[#00FF66] hover:underline">
              Cedar
            </a>{' '}
            policies blocking outbound traffic to public registries.
          </li>
          <li>
            (3) Add a SaifCTL Gate script (<code className={codeCls}>--gate-script</code>) that runs
            a dependency audit.
          </li>
        </ol>
      </>
    ),
  },
];

const RELIABILITY_ROWS: { threat: ReactNode; defense: ReactNode }[] = [
  {
    threat: 'An agent accidentally deletes your staging or production database',
    defense: (
      <>
        The agent never sees your real database. Its Docker network is physically isolated.
        <br />
        <br />
        Instead of a real database, define ephemeral mock services in{' '}
        <code className={codeCls}>docker-compose.yml</code>. If an ephemeral service crashes,
        SaifCTL detects it via health checks and halts the run immediately.
      </>
    ),
  },
  {
    threat:
      "An agent gets stuck in a retry loop Friday evening and burns through the team's API budget by Saturday morning",
    defense: (
      <>
        Configure max attempts as a hard circuit breaker. When the limit is reached, SaifCTL halts
        execution, saves the state, and sends an alert.
        <br />
        <br />
        Set budget caps at the user, team, and department level to limit LLM spend.
      </>
    ),
  },
  {
    threat:
      "Your team is running agents on their laptops and nobody has any idea what's happening, what it's costing, or whether any of it is working",
    defense:
      'SaifCTL has a centralized dashboard (self-hosted or managed cloud). Every run flows through it, regardless of where it was launched. Live terminal logs, API spend per team or per feature, health metrics, and a real-time map of the entire swarm. No shadow compute. No surprise bills.',
  },
  {
    threat:
      "AI-generated code is merged under a developer's identity, making it impossible to distinguish human from AI work in audit logs",
    defense: (
      <>
        Every SaifCTL commit is signed with a dedicated, verifiable Agent Identity (
        <code className={codeCls}>saifctl-agent[run-id]</code>). It never inherits your developer's
        gitconfig. Human commits and AI commits are always distinguishable in your Git history.
      </>
    ),
  },
];

const VSCODE_FEATURES = [
  {
    icon: '▶',
    title: 'Launch & monitor runs',
    body: 'Click Run on any feature. Watch the live agent log stream directly in the sidebar. Pause, cancel, or resume without leaving your editor.',
  },
  {
    icon: '🐛',
    title: 'One-click debug',
    body: "When a run fails, click Debug. A VSCode Remote Container opens with the agent's exact state. Fix the blocker and resume - all inside the same window you were already working in.",
  },
  {
    icon: '📁',
    title: 'Manage your feature backlog',
    body: 'Create features, write proposals. Directly from the sidebar tree view. Your SaifCTL feature backlog lives alongside your code, versioned in Git.',
  },
];
