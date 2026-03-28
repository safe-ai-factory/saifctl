'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Star, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { GITHUB_REPO } from '../constants';
import { track } from '../lib/analytics';
import { insertWaitlistEmail } from '../lib/supabase';

type Step = 'form' | 'star';

interface WaitlistModalProps {
  open: boolean;
  onClose: () => void;
}

export function WaitlistModal({ open, onClose }: WaitlistModalProps) {
  const [step, setStep] = useState<Step>('form');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the email input when modal opens + track open intent
  useEffect(() => {
    if (open && step === 'form') {
      setTimeout(() => inputRef.current?.focus(), 50);
      track('waitlist_open');
    }
  }, [open, step]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep('form');
        setEmail('');
        setStatus('idle');
        setErrorMsg('');
      }, 300);
    }
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');

    try {
      const { error } = await insertWaitlistEmail(email);

      if (error) {
        setStatus('error');
        // Postgres unique constraint violation
        if (error.code === '23505') {
          setErrorMsg("You're already on the list! We'll be in touch.");
        } else {
          setErrorMsg('Something went wrong. Please try again.');
        }
        return;
      }

      setStatus('idle');
      track('waitlist_submit');
      setStep('star');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Modal panel */}
          <motion.div
            key="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="waitlist-title"
            initial={{ opacity: 0, y: 32, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="pointer-events-auto w-full max-w-md bg-[#111] border border-[#333] rounded-2xl shadow-2xl overflow-hidden">
              {/* Header bar */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 bg-[#00FF66] rounded-sm flex items-center justify-center text-black font-bold font-mono text-xs">
                    S
                  </div>
                  <span className="font-mono font-bold tracking-tight text-white">SaifCTL</span>
                </div>
                <button
                  onClick={onClose}
                  className="text-gray-500 hover:text-white transition-colors p-1 rounded-md hover:bg-[#222]"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <AnimatePresence mode="wait">
                {step === 'form' ? (
                  <motion.div
                    key="form-step"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.2 }}
                    className="px-6 pb-6"
                  >
                    <h2 id="waitlist-title" className="text-xl font-bold text-white mb-1">
                      Get early access to SaifCTL
                    </h2>
                    <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                      Join the waitlist and we'll notify you when we launch or open alpha/beta.
                    </p>

                    <form
                      onSubmit={(e) => {
                        void handleSubmit(e);
                      }}
                      className="space-y-4"
                    >
                      <div>
                        <input
                          ref={inputRef}
                          type="email"
                          name="email"
                          required
                          placeholder="you@yourcompany.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          disabled={status === 'loading'}
                          className="w-full px-4 py-3 bg-[#0F0F0F] border border-[#333] text-white rounded-md focus:outline-none focus:border-[#00FF66] transition-colors font-mono text-sm placeholder:text-gray-600 disabled:opacity-60"
                        />
                        {errorMsg && (
                          <p className="text-red-400 text-xs font-mono mt-2">{errorMsg}</p>
                        )}
                      </div>

                      <button
                        type="submit"
                        disabled={status === 'loading'}
                        className="w-full px-6 py-3 bg-[#00FF66] hover:bg-[#00e05a] text-black font-bold rounded-md transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
                      >
                        {status === 'loading' ? (
                          <>
                            <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            Joining…
                          </>
                        ) : (
                          'Request Early Access'
                        )}
                      </button>
                    </form>

                    <p className="text-gray-600 text-xs mt-4 leading-relaxed">
                      We'll only email you about SaifCTL updates, launch, and open alpha/beta
                      announcements.{' '}
                      <a
                        href="/privacy"
                        className="hover:text-gray-400 underline underline-offset-2 transition-colors"
                      >
                        Privacy Policy
                      </a>
                      .
                    </p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="star-step"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.2 }}
                    className="px-6 pb-6"
                  >
                    <div className="text-3xl mb-3">🎉</div>
                    <h2 id="waitlist-title" className="text-xl font-bold text-white mb-1">
                      You're on the list!
                    </h2>
                    <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                      We'll notify <span className="text-white font-mono">{email}</span> when we
                      launch or open alpha/beta. While you wait - help SaifCTL get discovered by
                      starring the repo.
                    </p>

                    <a
                      href={GITHUB_REPO}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full px-6 py-3 bg-white hover:bg-gray-100 text-black font-bold rounded-md transition-colors flex items-center justify-center gap-2"
                      onClick={() => track('github_star_click')}
                    >
                      <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                      Star SaifCTL on GitHub
                    </a>

                    <p className="text-gray-600 text-xs mt-4 text-center">
                      GitHub stars help SaifCTL get discovered by more developers.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
