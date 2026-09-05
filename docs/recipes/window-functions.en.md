# Window functions

`GROUP BY` collapses rows; a window **keeps** every row and attaches a value computed
over a group. It is the difference between "how much each region sold" and "where this
sale ranks within its region".

```ts
import { over, rowNumber, select, sum } from "tempest-db-js";

const rows = await session
  .execute(
    select(Sale, ["id", "region"]).compute({
      position: over(rowNumber(), { partitionBy: ["region"], orderBy: [["total", "desc"]] }),
      running: over(sum("total"), {
        partitionBy: ["region"],
        orderBy: ["day"],
        frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
      }),
    }),
  )
  .all();
// rows[0].position is a number; so is rows[0].running
```

`compute()` projects expressions by alias — and, unlike `aggregate()`, it does **not**
group: every row stays.

## The functions

| Function | What it gives |
| --- | --- |
| `rowNumber()` | 1, 2, 3 … with no ties |
| `rank()` | ties share a position and the next one **skips** (1, 1, 3) |
| `denseRank()` | ties share and the next one **does not skip** (1, 1, 2) |
| `percentRank()` | the position as a fraction from 0 to 1 |
| `lag(col, n?)` / `lead(col, n?)` | the value a row behind / ahead |
| `firstValue(col)` / `lastValue(col)` | first / last value in the window |
| any aggregate | `over(sum("total"), …)`, `over(count(), …)` |

!!! danger "A window function without `OVER` does not compile — on purpose"

    ```ts
    select(Sale).compute({ previous: lag("total") });   // ❌ compile error
    ```

    `lag()` without `OVER` is a runtime error in the database ("misuse of window
    function"). These return a `WindowFn`, which only `over()` accepts — so the mistake
    becomes a type error.

!!! warning "The default frame is `RANGE`, and it lumps ties together"

    Without `frame`, SQL defaults to
    `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`: rows sharing the **same**
    ordering value all enter at once, so a running total jumps at a tie. When that
    matters, ask for `ROWS` explicitly, as above.

## Top N per group

```ts
const ranked = await session
  .execute(
    select(Sale, ["id", "region"]).compute({
      position: over(rowNumber(), { partitionBy: ["region"], orderBy: [["total", "desc"]] }),
    }),
  )
  .all();
const top = ranked.filter((r) => r.position <= 3);
```

!!! tip "Filtering on a window needs another level"

    `WHERE` runs **before** the window is computed, so the alias cannot be filtered in the
    same query — in SQL that calls for a subquery or a CTE. Filtering on the client
    (above) is fine for a small set; for a large table, wrap the query and filter outside.

## Recap

- `compute({ alias: over(fn, spec) })` — the row stays, the value comes along.
- `rowNumber`/`rank`/`denseRank`/`lag`/`lead`/… plus any aggregate.
- No `OVER` does not compile; with no explicit `frame` the default is `RANGE`. 🚀
