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

## Duração: `onQueryEnd`

`onQuery` dispara **antes** do statement rodar — logo, não mede nada. O par dele é o
`onQueryEnd`, que dispara depois, com o tempo que o driver levou:

```ts
const engine = createEngine("postgresql://app@localhost/app", {
  onQueryEnd: ({ sql, durationMs, rowCount, error }) => {
    metrics.histogram("db.query.ms", durationMs, { failed: error !== undefined });
    if (durationMs > 200) logger.warn({ sql, durationMs, rowCount }, "slow query");
  },
});
```

| Campo | O que traz |
| --- | --- |
| `sql` / `params` | os mesmos que o `onQuery` anunciou |
| `durationMs` | tempo de parede do driver |
| `rowCount` | linhas devolvidas (SELECT/`RETURNING`) ou afetadas (write) |
| `error` | o erro do driver, quando o statement falhou |

### Log de query lenta em uma linha

```ts
createEngine(url, {
  slowQueryMs: 200,
  onQueryEnd: ({ sql, durationMs }) => logger.warn({ sql, durationMs }, "slow query"),
});
```

Com `slowQueryMs`, o hook só é chamado para statement que cruza o limiar — é o log de
query lenta mais barato que existe, sem agente de APM.

!!! info "Dispara no erro também"

    Statement que falha chama `onQueryEnd` com `error` preenchido e `rowCount: 0`. O
    statement lento **que ainda por cima falha** é justamente o que interessa, e um hook
    que só visse o caminho feliz o perderia.

!!! tip "`stream()` é medido até o fim da iteração"

    Num `stream`, o tempo vai da compilação até a última linha consumida — que é o que
    responde "por que essa página demora". `rowCount` traz quantas linhas saíram.

Como `onQuery`, erro lançado dentro do `onQueryEnd` é engolido: logging nunca derruba a
query.

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

## Notices do servidor (`onNotice`)

O PostgreSQL emite `NOTICE` em coisas corriqueiras — `CREATE TABLE IF NOT EXISTS`
numa tabela que já existe, `DROP ... IF EXISTS` numa que não existe, criação de
constraint com índice implícito. Qualquer runner de migration bate nisso.

O driver `postgres.js` imprime esses notices com `console.log` por padrão, o que
larga um objeto de nove linhas no **stdout do seu serviço**, no meio do log
estruturado, a cada boot. O tempest-db-js **silencia** por default e te dá o hook:

```ts
const engine = createEngine(url, {
  onNotice: (notice) => logger.debug({ pg: notice }, "postgres notice"),
});
```

!!! info "Silenciar é o default de propósito"

    Escrever no stdout do processo hospedeiro é decisão da aplicação, não de uma
    biblioteca. Sem `onNotice`, o notice é descartado; com ele, você decide o
    nível, o formato e o destino.

Erro lançado dentro do `onNotice` é engolido, igual ao `onQuery`.

## Opções do driver (`driverOptions`)

Para o que a camada tipada não modela — `connection`, `types`, `transform`, `ssl`
do postgres.js, ajustes próprios do mysql2, `readOnly` do `node:sqlite`:

```ts
const engine = createEngine(url, {
  pool: { size: 10 },
  driverOptions: { ssl: "require", transform: { undefined: null } },
});
```

`driverOptions` é aplicado **por último** e vence tudo que a lib derivou
(inclusive `pool` e `onNotice`) — é escape hatch, então tem a última palavra.

## Por que esta query está lenta? `engine.explain`

Medir tempo diz **que** está lento; o plano diz **por quê**. Em vez de copiar SQL do log
e colar no psql — torcendo para os parâmetros serem os mesmos —, envolva o bloco:

```ts
const report = await engine.explain(async (session) => {
  await new BaseRepository(Order, session).paginate({ filters: { status: "open" }, page: 3 });
});

console.log(report.summary());
for (const plan of report.plans) {
  console.log(plan.sql, plan.params, plan.summary());
}
```

O bloco recebe uma session **gravadora**: os planos saem dos statements e dos parâmetros
que o código realmente usou.

| | PostgreSQL | SQLite |
| --- | --- | --- |
| Prefixo | `EXPLAIN (FORMAT JSON)` | `EXPLAIN QUERY PLAN` |
| `analyze: true` | `EXPLAIN (FORMAT JSON, ANALYZE)` | **erro** — não existe |

!!! danger "`analyze: true` **executa** o statement"

    É assim que ele mede. Por isso é recusado para qualquer coisa que não seja leitura —
    analisar um `UPDATE` o aplicaria uma segunda vez. Para explicar só as leituras de um
    bloco misto, passe `{ filter: isReadOnlyStatement }`.

!!! warning "Ferramenta de desenvolvimento"

    O bloco roda **e** cada statement ganha um `EXPLAIN` depois — o dobro de ida e volta.
    Use em teste, em investigação, num endpoint de debug; nunca no caminho quente.

## Recap

- `createEngine(url, { onQuery })` → hook por statement `{ sql, params }`.
- `{ onNotice }` → notices do servidor; **sem ele, nada é impresso**.
- Erro no logger é engolido — nunca quebra a query.
- Falha do driver → `QueryExecutionError` com `sql`, `params`, `cause`.
- `{ driverOptions }` repassa o que a lib não modela, aplicado por último.
