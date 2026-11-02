# Instructions for AI agents

Read `docs/AI-HANDBOOK.md` first: what the bot is, how it is deployed on Windows, how to change and release it, and the owner's rules (no added limits or keyword refusals, find root causes instead of patching prompts, never touch the owner's own QQ, few restarts). README.md describes features and their history.

# Development storage

- The authoritative project is `D:\Dev\Workspaces\bot-gpt-ds-codex-qq`.
- The original C: workspace path is a compatibility junction. Preserve it and existing Git references.
- Keep this project's outputs, caches and temporary data under the project on D:, normally `.runtime/`.
- Use `D:\Dev\Projects` for new standalone projects, `D:\Dev\Workspaces` for new task workspaces, and `D:\Dev\Outputs` for standalone deliverables without a project.
- Do not create new development workspaces or large caches on C:.
- Run `npm test` before committing; it runs every test in `tests/` and puts temporary files on D:.
- The upstream repository has its own additional instructions in `upstream/AGENTS.md`; that Swift project is reference only and no longer runs.
