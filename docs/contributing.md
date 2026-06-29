# Contribuindo

Obrigado pelo interesse em contribuir com o tempest-db-js! 🙌 Esta página cobre o setup de
desenvolvimento e as convenções do projeto.

## Setup

O tempest-db-js ainda não está no npm — durante o desenvolvimento, trabalhe a partir do
repositório:

```bash
git clone https://github.com/mauriciobenjamin700/tempest-db-js.git
cd tempest-db-js
npm install
```

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run test:types` | `tsc --noEmit` — a suíte de testes de **tipo**. |
| `npm test` | `vitest run` — testes de tipo + runtime. |
| `npm run test:watch` | Vitest em modo watch. |
| `npm run build` | `tsup` → ESM + CJS + `.d.ts`. |
| `npm run lint` | Biome. |
| `npm run format` | Biome (com `--write`). |

!!! tip "O teste de tipo é o teste de produto"

    Num ORM tipado, a maior parte do valor está nos **tipos**. Toda feature deve vir
    com testes de tipo (`tests/**/*.test-d.ts`) usando `expectTypeOf` e
    `@ts-expect-error`. Um filtro com chave inválida ou um update sem guard **tem**
    que falhar a compilação — e o teste verifica exatamente isso.

## Estrutura

```text
tempest-db-js/
├── src/
│   ├── index.ts        # Model, column, InferModel/InferInsert + re-exports
│   ├── query.ts        # select, SelectBuilder, AST de SELECT
│   └── mutations.ts    # insert/update/del, builders, guard de estado
├── tests/
│   └── *.test-d.ts     # testes de tipo (vitest typecheck)
├── docs/               # site MkDocs bilíngue (PT default + .en.md)
└── ROADMAP.md          # plano por fases
```

## Convenções de código

- **Aspas duplas** sempre.
- **Tudo tipado** — nada de `any` implícito; quando precisar de `any`, seja
  explícito.
- **Docstrings em inglês** (JSDoc), no estilo do código existente.
- **`strict: true`** — a inferência do tempest-db-js depende disso.

## Documentação segue o código

Mudou a superfície pública, comportamento, instalação ou recipes? **Atualize a
documentação no mesmo PR.** A regra:

1. **README.md** — snippets de instalação e a tabela "O que tem dentro".
2. **`docs/`** — página relevante (tutorial, referência, arquitetura) **nas duas
   línguas** (PT default + `.en.md`).

Rode `mkdocs build --strict` antes de commitar — o build precisa passar com **zero
warnings**.

```bash
pip install -r docs/requirements.txt
mkdocs serve   # preview local em http://127.0.0.1:8000
mkdocs build --strict
```

!!! info "Bilíngue é obrigatório"

    Toda página tem versão PT (sem sufixo) e EN (`<nome>.en.md`). Páginas sem
    tradução caem pro PT (fallback), mas o ideal é manter as duas em dia.

## Commits e PRs

- **Conventional commits**: `feat:`, `fix:`, `ref:`, `docs:`, `tests:`, `chore:`.
- **Branches**: `feat/`, `fix:`, `ref/`.
- PRs em português, descrevendo o problema e a solução.

## Recap

- `npm install`, depois `npm run test:types` e `npm test`.
- Toda feature vem com testes de tipo.
- Documente nas duas línguas, no mesmo PR, com `mkdocs build --strict` passando.
