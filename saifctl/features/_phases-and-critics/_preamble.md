Project conventions (always-needed preamble):

- Comments must reflect reality. If a TODO is done, delete it; do not flip it
  to "done" and leave the body. Lazy "(see X)" comments are not acceptable.
- Optional inputs whose default elevates access (e.g. `requireAuth = false`)
  are bugs even if the spec is silent on them. Default deny.
- Silent failure (`catch {}`, swallowed errors, fallthroughs returning
  success on partial state) is a bug; surface the failure with context.
