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
| raw node:sqlite | 7.2ms | 6.5ms | 2.5ms | 0.8ms |
| **tempest-db-js** | **64ms** | 22ms | 7ms | **5ms** |
| drizzle | 201ms | 6.9ms | 2.4ms | 16ms |
| kysely | 120ms | 4.7ms | 1.9ms | 6ms |

## Leitura

- **Insert / lookups:** tempest-db-js é **~2–3× mais rápido que Drizzle** e mais
  rápido que Kysely, apesar de recompilar o AST → SQL a cada query (sem cache de
  prepared statement ainda). A ausência de overhead de Promise no caminho sync
  ajuda bastante aqui.
- **Scan / filter:** tempest-db-js fica atrás nos scans grandes. O custo é a
  **coerção de linha por tipo** (`Date`/`bigint`/`json`/`boolean`), feita
  por-coluna-por-linha; Drizzle/Kysely retornam linhas mais próximas do cru.
  Otimizações candidatas: cache de compilação por query e um mapper de linha
  especializado por modelo (gerado uma vez, não por linha).

> ⚠️ Benchmark é diagnóstico, não marketing. O objetivo é guiar otimização
> (prepared-statement cache, row-mapper compilado) e detectar regressão, não
> declarar vencedor.
