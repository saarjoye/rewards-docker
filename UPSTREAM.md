# Upstream baseline

The Microsoft Rewards automation core is based on the public upstream project:

- Repository: `TheNetsky/Microsoft-Rewards-Script`
- Branch: `v4`
- Package version: `4.3.2`
- Commit: `d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e`
- Snapshot date: `2026-09-03`

The upstream core remains in the repository root. Project-specific code is isolated under `web/`, while `compose.yaml` connects the two containers. `src/`, `scripts/`, the dependency manifests, TypeScript configuration, and the core Dockerfile match the pinned upstream revision. Intentional repository-level differences are limited to local query settings in `config.example.json`, deployment and documentation files, plus browser globals in `eslint.config.mjs` for linting the independent Web assets.

## Manual upgrade procedure

1. Clone the desired upstream `v4` revision into a temporary directory without changing this repository's `origin` remote.
2. Compare and replace upstream-owned root, `src/`, and `scripts/` files. Do not copy upstream `compose.yaml` over the two-container deployment.
3. Reapply and review the intentional local-only query settings in `config.example.json`.
4. Update the pinned version and commit in this file and the core image tag in `compose.yaml`.
5. Run the upstream build, lint, format, and log-parser tests, then the complete `web/` test suite.
6. Build versioned images. Never publish or deploy a floating `latest` tag.

Do not carry old core patches forward automatically. Any new core deviation requires a documented reason and its own regression test.
