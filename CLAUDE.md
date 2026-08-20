# CLAUDE.md

Project rules. These apply to every session and every slice. If a request in chat
conflicts with these, stop and say so rather than proceeding.

## Read first

- `/docs/spec.md` — architecture and build plan
- `/docs/spike-findings.md` — verified facts. **Where this disagrees with spec.md,
  this wins.**
- `/docs/clink-notes.md` — CLINK field names, kinds, and error codes as read from
  the spec repo

## Never guess protocol details

Do not invent or recall from memory any CLINK event kind, field name, tag name, or
error code. Do not do this for NIP-99, NIP-5A, NIP-78, or Blossom either. Every such
detail must come from a spec file, source code, or captured event JSON, and must be
citable. If you cannot verify something, write `UNVERIFIED` and ask.

If training data and a spec file disagree, the spec file wins.

## Architectural rules (non-negotiable)

1. **No backend.** No server, no database, no accounts, no API of ours. If a feature
   seems to need one, stop and raise it — the answer is usually a signed event on a
   relay.
2. **No key handling outside the Signer.** Nothing in this codebase touches a private
   key except a `Signer` implementation. No nsec in memory elsewhere, no nsec in
   config, no nsec in logs.
3. **No node credentials leave the browser.** The seller's Lightning.Pub pairing is
   client-side only. `admin.connect` is `nprofile:token` with full node authority —
   it must never appear in this codebase, in config, in logs, or in a prompt. Use the
   narrowest credential that works.
4. **No secrets in the repo.** No committed `.env` with keys. CI signing uses NIP-46.
5. **The builder itself deploys as an nsite.** If our own app needs a server, the
   project's thesis is false.

## Money-path rules

- Treat every inbound event as hostile: verify signature, bound sizes, validate
  before parsing.
- Relays withhold, delay, reorder, and replay. Every retry on the money path must be
  idempotent, keyed on a settlement identifier.
- The refund path needs a hard cap and a kill switch before it goes anywhere near a
  real node.
- Never log secrets, preimages, or full event payloads containing them.

## Working style

- Build only the slice requested. Do not scaffold future slices, do not stub
  elaborate interfaces for work not yet scoped.
- Justify every new dependency. The storefront renders from a cold gateway cache;
  every KB is a blob fetch.
- Ask before installing anything global.
- After each slice, update `/docs/spec.md` with what was learned and tell me what
  changed.

## Context

Hackathon submission for "Best Use of CLINK." The pitch is that a static, serverless
site can take Lightning payments because CLINK requests travel over relays to the
seller's own node. Two comparable projects (Boltz, lnp2pbot) shut down in August 2026
after AI-assisted attacks outpaced small teams — the no-server, no-pooled-liquidity,
no-key-custody architecture here is the direct response to that. Preserving it is the
project.
