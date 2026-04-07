import type { ReactElement } from 'react';

export function DocContent({ content }: { content: ReactElement }) {
  return (
    <article
      className="prose prose-invert prose-sm max-w-none
        prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-fg
        prose-p:text-fg-muted prose-li:text-fg-muted
        prose-a:text-link prose-a:no-underline hover:prose-a:underline hover:prose-a:text-link-hover
        prose-code:text-accent prose-code:bg-accent-dim prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none
        prose-pre:hidden
        prose-blockquote:border-l-link prose-blockquote:text-fg-muted
        prose-strong:text-fg prose-table:text-sm"
    >
      {content}
    </article>
  );
}
