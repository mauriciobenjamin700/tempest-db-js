# Arquitetura

Esta página explica **as decisões de design** do tempest-db-js — por que ele é do jeito
que é. Se você só quer usar o ORM, o [Tutorial](tutorial/index.md) basta. Se quer
entender (ou contribuir), comece aqui.

## A restrição central: TypeScript apaga tipos

O SQLAlchemy 2.0 consegue ler `Mapped[int]` em **runtime**, porque o Python mantém
as anotações de tipo acessíveis via `typing.get_type_hints` e usa descriptors pra
fazer `User.id` significar coisas diferentes no acesso de classe (referência de
coluna) e de instância (valor).

O TypeScript **não tem** nada disso: os tipos são apagados na compilação. Em runtime,
`id: number` simplesmente não existe. Logo, uma classe assim seria **invisível** pro
ORM:

```ts
class User {
  id: number;     // ❌ some em runtime — o ORM não sabe que existe uma coluna
  name: string;
}
```

## A solução: a coluna é um valor

O tempest-db-js faz cada coluna ser um **valor em runtime** que carrega o tipo:

```ts
class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();   // runtime: objeto Column | tipo: Column<number, {...}>
  name = column.text().notNull();
}
```

O objeto `Column`:

- guarda em runtime o tipo SQL (`"INTEGER"`) e flags (`primaryKey`, `notNull`,
  `hasDefault`);
- carrega um **tipo fantasma** `T` (via um símbolo `declare`) que existe só no
  sistema de tipos, nunca em runtime.

A partir disso, mapped types extraem a forma da linha:

```ts
type ColValue<Col> = Col extends Column<infer T, infer F>
  ? F extends { notNull: true } | { primaryKey: true } ? T : T | null
  : never;

type InferModel<C> = { [K in ColumnKeys<InstanceType<C>>]: ColValue<InstanceType<C>[K]> };
```

!!! info "Mesmo princípio do Drizzle/Kysely"

    Drizzle e Kysely resolveram o mesmo problema do mesmo jeito: a coluna é um
    builder-valor, não uma anotação. O tempest-db-js adota essa base e a embrulha numa
    **classe declarativa**, pra ficar perto do SQLAlchemy.

## O trade-off honesto

Como a coluna é um valor, a linha retornada **não pode** ser uma instância da classe
com métodos (não dá pra `User.id` ser ao mesmo tempo `Column<number>` pra montar
query e `number` pra ler valor, sem o truque de descriptor do Python). Então:

- **Linhas são objetos planos inferidos** (`InferModel`), não instâncias ativas.
- **Active-record** (métodos na instância de linha, tipo `user.save()`) fica como
  objetivo **pós-MVP**.

Em troca, ganhamos **inferência de query forte** — o que mais importa num ORM
tipado.

## O query builder: AST pura + tipos fantasma

Os builders (`select`, `insert`, `update`, `del`) **não executam nada**. Cada um:

1. acumula uma **AST serializável** (`SelectNode`, `InsertNode`, ...), exposta em
   `.node`;
2. carrega **tipos fantasma** que descrevem o resultado, sem custo de runtime.

A execução é uma camada **separada** (`session.execute` + dialetos), que compila a
AST pra SQL parametrizado e roda contra o banco. Separar "montar" de "executar"
deixa toda a type-safety testável só com `tsc` (sem precisar de banco) e torna cada
builder reaproveitável em qualquer sessão.

### Dois parâmetros de tipo no `select`

```ts
class SelectBuilder<Full, Proj = Full> { ... }
```

- **`Full`** — a linha completa. Usado pra tipar as **chaves** de `where`/`orderBy`.
- **`Proj`** — a projeção. É o que a execução **retorna**.

Sem projeção, `Proj = Full`. Com `select(User, ["id"])`, `Proj = Pick<Full, "id">`.
Separar os dois permite filtrar por uma coluna que não está na projeção.

### O guard de estado em UPDATE/DELETE

`update` e `del` carregam um parâmetro de tipo `Guarded extends boolean`:

```ts
class UpdateBuilder<Full, Guarded extends boolean, Ret = number> { ... }
```

- nascem com `Guarded = false`;
- `.where(...)` ou `.unguarded()` produzem `Guarded = true`;
- o `session.execute` aceita **só** builders `Guarded = true` (tipo `Executable`).

Resultado: um `UPDATE`/`DELETE` sem `WHERE` e sem opt-in explícito é **erro de
compilação**, não um acidente em produção. Veja
[Inserir, atualizar, deletar](tutorial/mutations.md).

## Por que tudo isso é testável com `tsc`

Como builders são puro tipo + AST, os testes do tempest-db-js são majoritariamente
**testes de tipo** (`expectTypeOf`, `@ts-expect-error`). Um filtro com chave inválida
ou um update sem guard **falha a compilação** — e isso é exatamente o que os testes
verificam. Num ORM tipado, o tipo **é** o produto, então o teste de tipo é o teste de
produto.

## Mapa dos módulos

| Módulo | Responsabilidade |
| --- | --- |
| `src/index.ts` | `Model`, `column`, `InferModel`/`InferInsert`, `sql` + re-exports |
| `src/query.ts` | `select`, `SelectBuilder`, AST de SELECT, `WhereInput`, operadores |
| `src/mutations.ts` | `insert`/`update`/`del`, builders, guard de estado, AST |
| `src/conditions.ts` | combinadores `and`/`or`/`not` e a árvore `Condition` |
| `src/dialect.ts` | compila AST → SQL parametrizado (`SqliteDialect`/`PostgresDialect`) |
| `src/engine.ts` | `createEngine`/`createSyncEngine`, sessão, transações, drivers |
| `src/join.ts` | `join`, tipos compostos por alias, nullability de `leftJoin` |
| `src/relations.ts` | `hasMany`/`belongsTo` + `loadRelations` (eager-load sem N+1) |
| `src/repository.ts` | `BaseRepository<Model>` — CRUD + paginação tipada |
| `src/serialize.ts` | coerção linha ↔ dict ↔ JSON por tipo de coluna |
| `src/migrations/*` | Schema IR, diff, codegen, DAG, runner, CLI (estilo Alembic) |

## Recap

- TS apaga tipos → a coluna precisa ser um **valor** que carrega o tipo.
- Linhas são objetos planos inferidos; active-record é pós-MVP.
- Builders são **AST pura + tipos fantasma**; a execução é uma camada separada.
- `SelectBuilder<Full, Proj>` separa chave de filtro do resultado projetado.
- `Guarded extends boolean` transforma full-table write acidental em erro de
  compilação.
