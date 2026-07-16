# Askr package contract

Every public Askr npm package follows one release-facing contract while retaining its own runtime boundaries.

## Required metadata

- `@askrjs/*` package name and semantic version, starting at `0.0.1`
- Apache-2.0 license, ESM package type, and an explicit Node engine range
- GitHub repository, homepage, and issue tracker owned by `askrjs`
- public npm access, an intentional `files` or export surface, and a `./package.json` metadata export

Runtime libraries may support Node 18. Tooling and generated applications use the stricter Node range required by the current Vite toolchain.

## Required commands

- `lint` and `typecheck` keep style and compile-time contracts independently runnable
- `test` runs the package's behavior suites
- `build` creates the distributable or production application
- `test:publint` validates public package metadata
- `pack:check` inspects the actual tarball without recursively running lifecycle scripts
- `check` is the complete local release gate
- `prepack` rebuilds artifacts and `prepublishOnly` runs `check`

Browser packages may split their CI into deterministic non-browser and browser jobs, but their local `check` remains the complete gate.

## Shared product boundaries

- Product spelling is always **Askr**.
- `@askrjs/cli` owns project generation, updates, action generation, OpenAPI commands, and full or incremental SSG execution.
- `@askrjs/askr` owns runtime functions and executable SSR/SSG primitives, not command-line compatibility bins.
- Generated projects use Vite Plus commands and the same `lint`, `typecheck`, `test`, `build`, and `check` vocabulary.
- Current pre-1.0 package floors are explicit; generated projects do not target obsolete Askr surfaces.
