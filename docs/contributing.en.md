# Contributing

Thanks for your interest in contributing to tempest-db-js! 🙌 This page covers the
development setup and the project conventions.

## Setup

To develop (rather than just consume the npm package), work from the repository:

```bash
git clone https://github.com/mauriciobenjamin700/tempest-db-js.git
cd tempest-db-js
npm install
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run test:types` | `tsc --noEmit` — the **type** test suite. |
| `npm test` | `vitest run` — type + runtime tests. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run build` | `tsup` → ESM + CJS + `.d.ts`. |
| `npm run lint` | Biome. |
| `npm run format` | Biome (with `--write`). |

!!! tip "The type test is the product test"

    In a typed ORM, most of the value is in the **types**. Every feature should
    ship with type tests (`tests/**/*.test-d.ts`) using `expectTypeOf` and
    `@ts-expect-error`. A filter with an invalid key or an update without a guard
    **has** to fail to compile — and the test verifies exactly that.

## Structure

```text
tempest-db-js/
├── src/
│   ├── index.ts        # Model, column, InferModel/InferInsert + re-exports
│   ├── query.ts        # select, SelectBuilder, the SELECT AST
│   └── mutations.ts    # insert/update/del, builders, state guard
├── tests/
│   └── *.test-d.ts     # type tests (vitest typecheck)
├── docs/               # bilingual MkDocs site (PT default + .en.md)
└── ROADMAP.md          # phased plan
```

## Code conventions

- **Double quotes** always.
- **Everything typed** — no implicit `any`; when you need `any`, be explicit.
- **Docstrings in English** (JSDoc), in the style of the existing code.
- **`strict: true`** — tempest-db-js's inference depends on it.

## Documentation follows the code

Did you change the public surface, behavior, installation, or recipes? **Update
the documentation in the same PR.** The rule:

1. **README.md** — install snippets and the "What's inside" table.
2. **`docs/`** — the relevant page (tutorial, reference, architecture) **in both
   languages** (PT default + `.en.md`).

Run `mkdocs build --strict` before committing — the build must pass with **zero
warnings**.

```bash
pip install -r docs/requirements.txt
mkdocs serve   # local preview at http://127.0.0.1:8000
mkdocs build --strict
```

!!! info "Bilingual is mandatory"

    Every page has a PT version (no suffix) and an EN version (`<name>.en.md`).
    Pages without a translation fall back to PT, but the ideal is to keep both in
    sync.

## Commits and PRs

- **Conventional commits**: `feat:`, `fix:`, `ref:`, `docs:`, `tests:`, `chore:`.
- **Branches**: `feat/`, `fix:`, `ref/`.
- PRs in Portuguese, describing the problem and the solution.

## Recap

- `npm install`, then `npm run test:types` and `npm test`.
- Every feature ships with type tests.
- Document in both languages, in the same PR, with `mkdocs build --strict`
  passing.
