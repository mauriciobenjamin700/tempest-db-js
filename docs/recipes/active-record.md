# Active-record (opt-in)

Métodos de instância (`save`/`update`/`delete`/`reload`) numa linha — quando você
prefere esse estilo.

!!! info "Opt-in, não o padrão"

    O retorno padrão do tempest-db-js é um **objeto plano** inferido (decisão de
    projeto). O active-record é uma camada **explícita** por cima — você a usa
    quando quer, sem mudar o comportamento default de nenhuma query.

## O básico

```ts
import { Model, column, activeRecord, createEngine, sql } from "tempest-db-js";

class User extends Model {
  static tablename = "users";
  id = column.integer().primaryKey();
  name = column.text().notNull();
  age = column.integer().notNull();
  createdAt = column.datetime().notNull().default(sql.now());
}

const session = createEngine("sqlite:///app.db").session();
const users = activeRecord(User, session);

// Criar (ainda não salvo) → salvar
const u = users.create({ id: 1, name: "Ana", age: 30 });
await u.save();          // INSERT; u.data agora tem a linha completa (RETURNING)

// Atualizar
await u.update({ age: 31 });   // UPDATE ... WHERE id = 1; merge em u.data

// Recarregar do banco
await u.reload();        // re-fetch por PK; lança se sumiu

// Deletar
await u.delete();        // DELETE ... WHERE id = 1 → nº de linhas afetadas
```

## `.data` é a linha plana

Os campos vivem em `.data` — um objeto plano, tipado por `InferModel`:

```ts
u.data.name;   // string
u.data.age;    // number
```

Nada de proxy mágico: você lê/escreve `.data` e os métodos persistem. Isso mantém
a linha honesta com o resto da lib (o mesmo shape que um `select` devolve).

## O manager

`activeRecord(Model, session)` devolve um pequeno factory:

| Método | O que faz |
|---|---|
| `create(data)` | Cria um AR **não salvo** a partir de dados de insert. |
| `wrap(row)` | Embrulha uma linha **já carregada** como AR. |
| `get(id)` | Busca por PK e embrulha, ou `null` se não existe. |

```ts
const found = await users.get(1);   // ActiveRecord<User> | null
if (found) await found.update({ age: 40 });
```

## `save()` faz upsert

`save()` insere; se a PK já existe, sobrescreve (via `ON CONFLICT DO UPDATE`).
Só as colunas **presentes** em `.data` são sobrescritas — uma coluna ausente não
vira `null` nem apaga um default do banco.

## Quando usar

- **Use** quando o fluxo é centrado em uma entidade carregada (editar → salvar).
- **Prefira o `BaseRepository`** para CRUD/paginação em lote e consultas.
- **Prefira o builder puro** (`select`/`insert`/...) para queries complexas.

## Recap

- `activeRecord(Model, session)` → `create`/`wrap`/`get`.
- `ActiveRecord`: `save` (upsert), `update`, `delete`, `reload`; campos em `.data`.
- Camada opt-in — o retorno plano default não muda.
