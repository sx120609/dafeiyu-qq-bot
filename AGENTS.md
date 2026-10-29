# Development storage

- The authoritative project is `D:\Dev\Workspaces\bot-gpt-ds-codex-qq`.
- The original C: workspace path is a compatibility junction. Preserve it and existing Git references.
- Keep this project's outputs, caches and temporary data under the project on D:, normally `.runtime/`.
- Use `D:\Dev\Projects` for new standalone projects, `D:\Dev\Workspaces` for new task workspaces, and `D:\Dev\Outputs` for standalone deliverables without a project.
- Do not create new development workspaces or large caches on C:.
- Run `npm test` for the gateway and control tests; it puts temporary files on D:.
- The upstream repository has its own additional instructions in `upstream/AGENTS.md`.
