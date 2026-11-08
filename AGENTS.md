# AGENTS.md

Repo-wide instructions for agents working in this repository.
Per-repo configuration for the engineering skills lives under `docs/agents/`.


<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

<!-- CODEGRAPH_END -->

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `whutlichao/superagent-plugin`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to labels of the same name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` and `docs/adr/` at the repository root, created lazily by the domain-modeling skill. See `docs/agents/domain.md`.
