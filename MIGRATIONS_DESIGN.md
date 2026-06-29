# Querium — Design das Migrações (Fase 6)

> Design detalhado do sistema de migrações. Inspiração explícita: **Alembic**
> (SQLAlchemy). Anti-inspiração explícita: a "costura de SQL" do **drizzle-kit**.

## Decisões travadas

| Decisão | Escolha | Por quê |
|---|---|---|
| Migração é... | **Script TS com `up()`/`down()`** chamando uma API de operações tipadas | Nunca SQL string solto; reversível; data migration + DDL no mesmo arquivo. |
| Fonte do "estado atual" | **Híbrido**: replay das migrações → IR virtual (diff aqui) **+** introspecção do banco só pra detectar drift | Gera revision sem DB conectado; ainda alerta divergência. |
| Grafo de revisões | **DAG desde o início** (`down_revision` é lista) | Branch/merge entre devs sem colisão de head. |
| Reversibilidade | **`down()` autogerado e editável**; op irreversível emite `down()` com `throw` + TODO | Garante rollback de verdade (o que falta no Drizzle). |
| Render de SQL | **Por dialeto, na borda** (SQLite/Postgres), nunca pelo usuário | DDL correto por banco; SQLite ganha batch mode. |

## Anti-goals (o que NÃO queremos)

- ❌ Pasta de `.sql` crus que o dev edita na mão.
- ❌ Migração sem `down()` (rollback impossível).
- ❌ Rename de coluna virar `DROP` + `ADD` silencioso (perde dados).
- ❌ Snapshot opaco como única fonte (cego a drift).
- ❌ Lógica de DDL espalhada — SQL só nasce no renderer do dialeto.

---

## 1. Arquitetura em camadas

O segredo anti-Drizzle: **tudo flui por uma IR de schema + operações tipadas. SQL
só aparece na última borda.**

```text
┌─────────────────────────────────────────────────────────────────┐
│  FONTES DE ESTADO (cada uma produz a MESMA Schema IR)             │
│                                                                   │
│   Modelos (classes)  ──reflect──►  IR-alvo                        │
│   Migrações (replay) ──replay───►  IR-atual  ◄── fonte da verdade │
│   Banco real         ──introspect─► IR-banco  ── só drift check   │
└─────────────────────────────────────────────────────────────────┘
                 │ IR-alvo            │ IR-atual
                 ▼                    ▼
          ┌──────────────────────────────────┐
          │  DIFFER  (IR × IR → Operações[])  │
          └──────────────────────────────────┘
                 │ Operação[] (tipadas, reversíveis)
        ┌────────┴─────────┐
        ▼                  ▼
┌───────────────┐   ┌──────────────────────────────┐
│ AUTOGENERATOR │   │ RUNTIME EXECUTOR              │
│ Ops → script  │   │ up()/down() chamam op.* que   │
│ TS up()/down()│   │ → RENDERER do dialeto → SQL   │
└───────────────┘   └──────────────────────────────┘
```

Camadas e responsabilidades:

| Camada | Entrada | Saída | Onde mora |
|---|---|---|---|
| **Reflect** | Classes `Model` | `SchemaIR` | `migrations/reflect.ts` |
| **Replay** | Arquivos de migração | `SchemaIR` | `migrations/replay.ts` |
| **Introspect** | Conexão de banco | `SchemaIR` | `dialects/*/introspect.ts` |
| **Differ** | 2× `SchemaIR` | `Operation[]` | `migrations/diff.ts` |
| **Operations** | — | tipos + inverso | `migrations/operations.ts` |
| **Renderer** | `Operation` + dialeto | SQL parametrizado | `dialects/*/ddl.ts` |
| **Autogenerator** | `Operation[]` | arquivo `.ts` de migração | `migrations/codegen.ts` |
| **Graph** | Arquivos de migração | DAG + heads | `migrations/graph.ts` |
| **Runner** | DAG + DB | aplica/reverte + version table | `migrations/runner.ts` |
| **CLI** | argv | orquestra tudo | `cli/` |

---

## 2. Schema IR (a peça central)

A IR é a descrição **canônica e dialect-neutral** de um schema. As três fontes
(reflect, replay, introspect) produzem a mesma estrutura, então o differ compara
maçã com maçã. Reusa o `ColumnType` já existente em `src/index.ts`.

```ts
interface SchemaIR {
  readonly tables: Record<string, TableIR>; // chaveado por nome de tabela
}

interface TableIR {
  readonly name: string;
  readonly columns: Record<string, ColumnIR>;
  readonly primaryKey: readonly string[];        // colunas da PK (composta = N)
  readonly uniques: readonly UniqueIR[];
  readonly indexes: readonly IndexIR[];
  readonly foreignKeys: readonly ForeignKeyIR[];
  readonly checks: readonly CheckIR[];
}

interface ColumnIR {
  readonly name: string;
  readonly type: ColumnType;        // { kind, meta } — reusado do core
  readonly notNull: boolean;
  readonly default: DefaultIR | null;
}

// Default precisa distinguir literal de expressão SQL pra render correto e diff estável.
type DefaultIR =
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "expression"; readonly sql: string } // ex.: "now()", "gen_random_uuid()"
  | { readonly kind: "sequence" }                          // autoincrement / serial

interface ForeignKeyIR {
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: FkAction;  // "cascade" | "restrict" | "set null" | "no action"
  readonly onUpdate: FkAction;
}
// UniqueIR, IndexIR, CheckIR análogos.
```

!!! nota
    A IR é **serializável** (JSON puro). Isso permite snapshot opcional em disco
    pra acelerar replay em históricos longos (cache), mas a fonte da verdade
    continua sendo o replay das migrações — o snapshot é só derivado/cacheado.

---

## 3. Catálogo de operações (tipadas + reversíveis)

Cada operação é um objeto tipado com um **inverso conhecido**. É isso que dá `down()`
autogerado e DDL por dialeto. Espelha o `op.*` do Alembic.

```ts
type Operation =
  | { kind: "create_table"; table: TableIR }
  | { kind: "drop_table"; table: TableIR }                 // guarda IR p/ inverter
  | { kind: "rename_table"; from: string; to: string }
  | { kind: "add_column"; table: string; column: ColumnIR }
  | { kind: "drop_column"; table: string; column: ColumnIR } // guarda ColumnIR p/ recriar
  | { kind: "alter_column"; table: string; name: string;
      from: ColumnIR; to: ColumnIR }                       // from/to → inverso trivial
  | { kind: "rename_column"; table: string; from: string; to: string }
  | { kind: "create_index"; table: string; index: IndexIR }
  | { kind: "drop_index"; table: string; index: IndexIR }
  | { kind: "add_foreign_key"; table: string; fk: ForeignKeyIR }
  | { kind: "drop_foreign_key"; table: string; fk: ForeignKeyIR }
  | { kind: "add_unique" | "drop_unique"; table: string; unique: UniqueIR }
  | { kind: "add_check" | "drop_check"; table: string; check: CheckIR }
  | { kind: "execute"; up: string; down: string | null }   // escape hatch (data migration)
```

**Regra de inverso** (`invert(op): Operation`):

| Operação | Inverso |
|---|---|
| `create_table` | `drop_table` (mesma IR) |
| `drop_table` | `create_table` (IR guardada) |
| `add_column` | `drop_column` |
| `drop_column` | `add_column` (ColumnIR guardada) |
| `alter_column {from,to}` | `alter_column {from:to, to:from}` |
| `rename_*` | `rename_*` trocando from/to |
| `create_index` | `drop_index` (e vice-versa) |
| `execute {up,down}` | `execute {up:down, down:up}`; se `down` for `null` → **irreversível** |

Como cada op carrega o necessário pra se inverter (a IR de uma tabela/coluna
dropada fica embutida), o `down()` autogerado é **completo**, não um stub.

---

## 4. Formato do arquivo de migração

Script TS, editável, com identidade no grafo. **Sem SQL string** no caso comum —
só chamadas `op.*`. O `op.execute()` existe pro caso de data migration.

```ts
// migrations/20260629_143000_add_role_to_users.ts
import type { Migration, Op } from "querium/migrations";

export const revision = "7f3a9c2b";
export const downRevision: string[] = ["a1b2c3d4"]; // lista → suporta merge (DAG)
export const label = "add role to users";

export const up = async (op: Op): Promise<void> => {
  op.addColumn("users", {
    name: "role",
    type: { kind: "enum", meta: { values: ["admin", "user", "guest"] } },
    notNull: true,
    default: { kind: "literal", value: "user" },
  });
  op.createIndex("users", { name: "ix_users_role", columns: ["role"] });
};

export const down = async (op: Op): Promise<void> => {
  // autogerado invertendo up(), editável
  op.dropIndex("users", { name: "ix_users_role", columns: ["role"] });
  op.dropColumn("users", { name: "role", type: { kind: "enum", meta: { values: ["admin", "user", "guest"] } }, notNull: true, default: { kind: "literal", value: "user" } });
};
```

`Op` é a fachada que o runtime injeta: cada método empilha uma `Operation`, e o
runner a manda pro renderer do dialeto ativo. Em modo `--sql` (offline), o runner
só **coleta o SQL** sem executar.

!!! danger "Operações irreversíveis"
    Quando o autogenerate não consegue inverter com segurança (ex.: `op.execute`
    de data migration sem down óbvio, ou drop de coluna com dados), ele emite um
    `down()` que **lança erro** com um TODO claro:
    ```ts
    export const down = async (): Promise<void> => {
      throw new IrreversibleMigration("dropcolumn users.legacy_data: revise manualmente");
    };
    ```
    Nada de rollback silencioso e quebrado.

---

## 5. Grafo de revisões (DAG)

`down_revision` é **lista de pais** → o histórico é um DAG, não uma corrente.

```text
a1 → b2 → c3 ─┐
              ├─ merge(e5) → f6
        d4 ───┘
```

- **`revision`**: id curto estável (hash, ex. `7f3a9c2b`). Não usar timestamp como
  id (timestamp vai no nome do arquivo só pra ordenação visual).
- **`downRevision: string[]`**: 0 pais = migração inicial; 1 pai = linear; 2+ =
  merge.
- **head(s)**: revisões sem filhos. Duas branches paralelas = 2 heads → `querium
  merge` cria uma revisão de merge com os dois como pais.
- **Ordem de aplicação**: ordenação topológica do DAG. Empates resolvidos de forma
  determinística (por id) pra builds reprodutíveis.
- **Detecção de ciclo**: o loader valida que o grafo é acíclico; ciclo = erro.

!!! info "Por que DAG desde já"
    Dois devs criam migração ao mesmo tempo → duas branches a partir do mesmo
    pai → dois heads. Sem DAG, isso é colisão e merge manual de arquivo. Com DAG,
    `querium merge` resolve. Modelar isso depois exigiria refactor do loader e do
    runner; a estrutura de dados (lista de pais) custa o mesmo agora.

---

## 6. Autogenerate (o algoritmo)

```text
1. IR-alvo   ← reflect(models)
2. IR-atual  ← replay(migrations até o head)        # NÃO precisa de DB
3. ops       ← diff(IR-atual, IR-alvo)
4. (se DB conectado) IR-banco ← introspect(db)
   drift     ← diff(IR-atual, IR-banco)
   se drift ≠ ∅ → AVISA: "banco diverge das migrações" (não bloqueia)
5. ops       ← detectRenames(ops)                   # heurística interativa
6. arquivo   ← codegen(revision, head, ops, invert(ops))
```

O **diff** é puramente estrutural sobre a IR:

- Tabela em alvo e não em atual → `create_table`. O inverso popula `drop_table`.
- Coluna com `type`/`notNull`/`default` diferente → `alter_column {from, to}`.
- Índice/unique/FK/check: compara por forma normalizada.
- Ordem das ops respeita dependências (criar tabela antes de FK que aponta pra ela;
  dropar FK antes da tabela).

### Rename: o ponto sensível

O diff puro vê rename como `drop` + `add` (igual Alembic e Drizzle). Para não perder
dados:

- **Heurística**: coluna sumiu e outra apareceu na mesma tabela com **tipo
  idêntico** → candidato a rename.
- **Confirmação interativa** no CLI: `"users.name sumiu e users.full_name apareceu
  (mesmo tipo). É rename? [s/N]"`. Sim → emite `rename_column`; não → `drop`+`add`.
- **Modo não-interativo** (CI): nunca adivinha; sempre `drop`+`add` e **loga em
  destaque** o que foi tratado como destrutivo (sem cap silencioso).

---

## 7. SQLite batch mode (ALTER fraco)

SQLite só faz `ADD COLUMN` e `RENAME`; não faz `DROP COLUMN` (em versões antigas),
`ALTER COLUMN`, mudar constraint. Alembic resolve com **batch mode**: recria a
tabela. Vamos copiar.

Quando o renderer SQLite recebe uma op não suportada nativamente, ele expande pra
sequência de **table-rebuild**:

```sql
-- alter_column / drop_column / mudar constraint em SQLite:
PRAGMA foreign_keys=off;
BEGIN;
CREATE TABLE _users_new ( ...schema novo... );
INSERT INTO _users_new (col_comuns) SELECT col_comuns FROM users;
DROP TABLE users;
ALTER TABLE _users_new RENAME TO users;
-- recria índices/triggers
COMMIT;
PRAGMA foreign_keys=on;
```

Isso é **gerado pelo renderer**, transparente pro autor da migração — ele só
escreveu `op.alterColumn(...)`. Postgres recebe `ALTER TABLE ... ALTER COLUMN ...`
direto. **Mesma migração, dialetos diferentes** — o ponto-chave.

---

## 8. Version tracking

Tabela de controle no banco, criada na primeira execução:

```sql
CREATE TABLE querium_migrations (
  revision     TEXT PRIMARY KEY,
  applied_at   TIMESTAMP NOT NULL,
  -- guarda o caminho aplicado p/ auditoria do DAG
  down_revision TEXT
);
```

- `querium upgrade head`: calcula ordem topológica das revisões não aplicadas e
  aplica cada `up()` numa transação (onde o dialeto suporta DDL transacional —
  Postgres sim; SQLite sim; alguns DDL no MySQL não, mas MySQL está fora do escopo
  inicial).
- `querium downgrade <rev>`: aplica `down()` na ordem inversa até a revisão alvo.
- **Lock**: advisory lock (Postgres) ou arquivo-lock (SQLite) pra evitar duas
  migrações concorrentes em deploy.

---

## 9. CLI

Espelha o vocabulário do Alembic (familiaridade) com nomes claros:

| Comando | Faz |
|---|---|
| `querium revision -m "msg"` | Cria migração **vazia** (up/down em branco). |
| `querium revision --autogenerate -m "msg"` | Diff models × replay → migração preenchida. |
| `querium upgrade head` | Aplica até o(s) head(s). |
| `querium upgrade +1` / `<rev>` | Aplica N passos / até revisão. |
| `querium downgrade -1` / `<rev>` / `base` | Reverte. |
| `querium current` | Revisão(ões) aplicada(s) no banco. |
| `querium history` | Mostra o DAG (ascii). |
| `querium heads` | Lista heads (avisa se >1). |
| `querium merge <rev1> <rev2> -m "msg"` | Cria revisão de merge. |
| `querium stamp <rev>` | Marca como aplicada sem rodar (adoção em base existente). |
| `querium check` | Falha se models divergem das migrações (gate de CI). |
| `querium upgrade head --sql` | **Offline**: imprime o SQL em vez de executar. |

`querium check` no CI é o que impede "esqueci de gerar a migração": se o diff
models×replay não for vazio, falha o build.

---

## 10. Riscos / pontos abertos

- **Defaults como expressão** (`now()`, `gen_random_uuid()`) variam por dialeto —
  precisamos de um pequeno mapa de defaults-portáveis (ex.: `Default.now()` →
  `CURRENT_TIMESTAMP`/`now()`), senão o diff fica instável (string crua difere
  entre bancos).
- **Introspecção** é a parte mais chata por dialeto (catálogos `pg_catalog` vs
  `pragma table_info`). Como é só pra drift check (não bloqueia geração), pode vir
  depois do MVP da Fase 6.
- **Normalização de tipo** no diff: `varchar(255)` introspectado precisa bater com
  `column.varchar(255)`. Precisamos de uma forma canônica de `ColumnType` por
  dialeto pra comparar.
- **Enum no Postgres** é um tipo nomeado (`CREATE TYPE`) com migração própria (add
  value é especial); no SQLite vira `TEXT` + `CHECK`. Tratar enum como cidadão de
  primeira no renderer.
- **Transação de DDL**: garantir rollback parcial coerente quando uma migração
  falha no meio.

---

## 11. Entrega faseada (dentro da Fase 6)

1. **6a — Núcleo offline**: Schema IR + reflect(models) + operations + differ +
   renderer SQLite/Postgres + autogenerator. `revision --autogenerate` e `upgrade
   --sql` funcionando **sem executar** (saída SQL). Testável 100% com snapshots.
2. **6b — Runtime**: runner + version table + `upgrade`/`downgrade` reais + lock.
3. **6c — DAG completo**: `merge`, `heads`, ordenação topológica, `history` ascii.
4. **6d — Drift + introspecção**: `introspect` por dialeto + `check` + aviso de
   drift.
5. **6e — Ergonomia**: rename interativo, batch mode SQLite polido, defaults
   portáveis, enum nomeado no Postgres.

Cada sub-fase entrega valor sozinha; 6a já substitui o drizzle-kit no fluxo
"mudei o model → gera migração", mas com `down()` e operações tipadas.
```
