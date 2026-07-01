# Benchmarks

Micro-benchmark de tempest-db-js contra **Drizzle** e **Kysely** em SQLite,
usando `raw node:sqlite` como piso teórico (o driver sem nenhuma camada de ORM).

## Como rodar

```bash
npm run bench                    # 20.000 linhas, mediana de 5 execuções
node bench/sqlite-bench.mjs 50000 7   # parametrizável: [linhas] [repetições]
```

O script (`bench/sqlite-bench.mjs`) roda quatro workloads idênticos em cada
biblioteca e reporta a **mediana** do tempo de parede:

| Workload | Descrição |
|---|---|
| `insert N` | Inserção em massa de N linhas dentro de **uma** transação. |
| `scan all` | `SELECT *` da tabela inteira. |
| `filter scan` | `SELECT * WHERE age > 40 AND active = 1`. |
| `1000 lookups` | 1.000 buscas por PK (`WHERE id = ?`), uma query por iteração. |

## Ressalvas de metodologia

- **Drivers diferentes.** tempest-db-js usa o built-in `node:sqlite`; Drizzle e
  Kysely usam `better-sqlite3` (nativo). Não é um shootout puro de driver — é
  "cada lib no stack que ela usa de verdade".
- **API async do Kysely.** Kysely expõe API assíncrona; o overhead de Promise
  por query aparece principalmente em `insert` e `lookups` (uma query por await).
- Números dependem da máquina. A tabela abaixo é de uma execução em WSL2 /
  Node 24, 20.000 linhas, mediana de 7 — use como ordem de grandeza, não valor
  absoluto.

## Resultado representativo (20.000 linhas, Node 24 / WSL2)

| library | insert 20k | scan all | filter scan | 1000 lookups |
|---|--:|--:|--:|--:|
| raw node:sqlite | 7.2ms | 6.2ms | 2.5ms | 0.8ms |
| **tempest-db-js** | **26ms** | **10ms** | **3.5ms** | **1.8ms** |
| drizzle | 207ms | 6.5ms | 2.5ms | 17ms |
| kysely | 122ms | 4.8ms | 2.0ms | 6.4ms |

## Leitura

- **Insert / lookups:** tempest-db-js é **~5–8× mais rápido que Drizzle** e
  ~3–4× mais rápido que Kysely. Fica logo acima do piso `node:sqlite`. A
  ausência de overhead de Promise no caminho sync + o cache de prepared
  statement (reuso do `prepare()` por texto SQL) dominam o ganho.
- **Scan / filter:** perto do piso e à frente de Drizzle/Kysely nos scans
  grandes. A coerção de linha por tipo (`Date`/`bigint`/`json`/`boolean`) usa um
  **row-mapper compilado por modelo** (decoders pré-resolvidos por coluna,
  memoizados), em vez de re-refletir o modelo e re-dispatchar o switch por linha.

### O que mudou (otimizações aplicadas)

- **Cache de prepared-statement** no `NodeSqliteDriver`: `prepare()` por texto
  SQL, reusado entre execuções. Maior ganho no insert/lookup.
- **`columnsOf` memoizado** por classe (WeakMap): antes reinstanciava o modelo a
  cada linha lida.
- **Row-mapper compilado**: `coerceRow` usa um mapa de decoders por coluna
  (só as que precisam de coerção), montado uma vez por modelo.

> ⚠️ Benchmark é diagnóstico, não marketing. O objetivo é guiar otimização e
> detectar regressão, não declarar vencedor. Próximos candidatos: cache da
> compilação AST → SQL por forma de query, e batch de INSERT multi-row.
