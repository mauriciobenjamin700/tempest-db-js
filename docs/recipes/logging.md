# Logging de query e erros com contexto

Ver o SQL que roda, e saber exatamente qual query falhou.

## Logando toda query

Passe `onQuery` nas opções do engine — ele é chamado por statement, com o SQL e
os params ligados:

```ts
import { createEngine } from "tempest-db-js";

const engine = createEngine("sqlite:///app.db", {
  onQuery: ({ sql, params }) => {
    console.debug(sql, params);
  },
});
```

O hook roda para **todo** statement da session: `execute`, `stream`, e os
`BEGIN`/`COMMIT`/`SAVEPOINT` das transações.

!!! warning "O logger nunca quebra a query"

    Se o seu `onQuery` lançar, o erro é **engolido** — logging jamais derruba a
    execução. Não confie nele para lógica de negócio.

!!! tip "Tracing / métricas"

    `onQuery` é o ponto para medir latência (marque tempo, correlacione por SQL),
    contar queries por request, ou alimentar um tracer.

## Erros com o SQL que falhou

Quando o driver rejeita um statement, tempest-db-js lança `QueryExecutionError`
— com o SQL e os params anexados, em vez de uma mensagem opaca do driver:

```ts
import { QueryExecutionError, insert } from "tempest-db-js";

try {
  session.execute(insert(User).values({ id: 1, name: "dup" }));
  session.execute(insert(User).values({ id: 1, name: "dup" })); // PK duplicada
} catch (err) {
  if (err instanceof QueryExecutionError) {
    console.error(err.message); // inclui "SQL: INSERT INTO ... params: [...]"
    err.sql;    // o SQL exato que falhou
    err.params; // os params ligados, em ordem
    err.cause;  // o erro original do driver
  }
}
```

A `message` já traz um preview seguro (valores longos truncados, blobs como
`<N bytes>`); as props `sql`/`params` têm o conteúdo completo para você logar.

## Recap

- `createEngine(url, { onQuery })` → hook por statement `{ sql, params }`.
- Erro no logger é engolido — nunca quebra a query.
- Falha do driver → `QueryExecutionError` com `sql`, `params`, `cause`.
