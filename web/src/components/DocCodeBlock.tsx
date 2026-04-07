'use client';

import hljs from 'highlight.js';
import { useMemo, useState } from 'react';

type Props = {
  lang?: string;
  code: string;
};

function decodeCode(raw: string): string {
  try {
    // code prop is base64-encoded by sync-docs.ts to survive MDX/acorn parsing.
    // atob() is Latin-1 only — use TextDecoder for correct UTF-8 handling of
    // multi-byte characters like box-drawing glyphs (├, └, │, etc.).
    if (typeof window !== 'undefined') {
      const binary = atob(raw);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return raw;
  }
}

export function DocCodeBlock({ lang, code: rawCode }: Props) {
  const [copied, setCopied] = useState(false);

  const code = useMemo(() => decodeCode(rawCode), [rawCode]);

  const highlighted = useMemo(() => {
    if (!code) return '';
    if (lang) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // fall through to auto-detect
      }
    }
    return hljs.highlightAuto(code).value;
  }, [lang, code]);

  function handleCopy() {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="doc-code-block not-prose">
      {lang && <span className="doc-code-lang">{lang}</span>}
      <button
        className={`doc-code-copy${copied ? ' doc-code-copy--copied' : ''}`}
        aria-label="Copy code to clipboard"
        onClick={handleCopy}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre>
        <code
          className={`hljs${lang ? ` language-${lang}` : ''}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}
