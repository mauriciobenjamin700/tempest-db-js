# Text search

Two layers, because they answer different questions.

## Layer 1: `contains` — escaped substring, identical everywhere

```ts
import { contains, select } from "tempest-db-js";

session.execute(select(User).where(contains(["name", "email"], term)));
```

- The term is **tokenized**: `"ana silva"` requires `ana` **and** `silva`, each free to
  appear in any of the columns. Typing more words narrows the result, which is what a
  search box needs.
- Every token is **escaped**. No index, no extension, no migration.
- `{ match: "any" }` swaps "all of them" for "any one".

!!! danger "A raw `ilike` turns `100%` into "everything""

    `%` and `_` are `LIKE` wildcards. Passing what the user typed straight into
    `{ ilike: term }` makes `100%` match **every row**:

    ```ts
    where({ title: { ilike: "100%" } })          // ❌ matches everything
    where({ title: { iContains: "100%" } })      // ✅ matches a literal "100%"
    where(contains(["title"], "100%"))           // ✅ same, across columns
    ```

    The `iContains` operator takes **text**, not a pattern: it escapes and wraps the
    `%…%` itself. To build a pattern by hand, escape it with `escapeLike(term)`.

!!! info "The `ESCAPE '\'` is not decoration"

    PostgreSQL already treats `\` as the escape character by default; **SQLite has none
    at all** until one is declared. Without the `ESCAPE` clause the escaping done on our
    side would mean nothing there — which is why it is always emitted.

## Layer 2: `fullText` — stemming and ranking on PostgreSQL

```ts
const term = "buy";
session.execute(
  select(Post)
    .where(fullText(["title", "body"], term, { language: "english" }))
    .orderBy(fullTextRank(["title", "body"], term, { language: "english" }), "desc"),
);
```

On PostgreSQL this becomes `to_tsvector(...) @@ websearch_to_tsquery(...)`: **stemming**
(`buy` finds "buying"), stop-word removal, and the quoting and `-exclusion` syntax users
already know from search engines. `fullTextRank` becomes `ts_rank`.

!!! warning "Outside PostgreSQL it falls back to layer 1 — deliberately"

    On SQLite (and MySQL) `fullText` compiles as `contains`: **the right rows, without
    stemming**. A development database keeps working, and the difference is ranking
    quality, not correctness.

    `fullTextRank` becomes a constant there, so ordering by it is inert — ranking is the
    part that genuinely does not exist without a text-search engine.

!!! tip "`coalesce` on every column"

    The document is `coalesce(col, '')` concatenated. In SQL a `NULL` anywhere in a
    concatenation makes the **whole document** `NULL` — one empty column would drop the
    row out of the search with no warning.

## Indexing

`fullText` works without an index, but it scans. In production, create the GIN index
over the **same** expression:

```sql
CREATE INDEX ix_posts_fts ON posts
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '')));
```

## Recap

- Search box ⇒ `contains` (or the `iContains` operator).
- Need stemming and ranking on PostgreSQL ⇒ `fullText` + `fullTextRank`.
- `escapeLike` for hand-built patterns.
- Outside PostgreSQL, full text degrades to substring — documented, not silent. 🚀
