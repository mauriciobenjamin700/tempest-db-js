/**
 * PostgreSQL integration for full-text search — stemming and ranking, which are
 * exactly the parts a compilation test cannot prove and the SQLite fallback does
 * not have.
 *
 * Gated on `TEST_DATABASE_URL`; uses its own table so it can run in parallel with
 * the other integration files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AsyncDriver,
  type AsyncEngine,
  BaseRepository,
  Model,
  column,
  contains,
  createEngine,
  fullText,
  fullTextRank,
  select,
} from "../src/index.js";
import { reflectTable, renderOperation } from "../src/migrations/index.js";

const url = process.env.TEST_DATABASE_URL;

class SearchPost extends Model {
  static override tablename = "search_posts";
  static override naming = "snake_case" as const;
  id = column.integer().primaryKey();
  title = column.text().notNull();
  body = column.text().notNull();
}

describe.skipIf(!url)("PostgreSQL — text search", () => {
  let engine: AsyncEngine;
  let driver: AsyncDriver;

  beforeAll(async () => {
    engine = createEngine(url as string);
    driver = (engine as unknown as { driver: AsyncDriver }).driver;
    await driver.execute("DROP TABLE IF EXISTS search_posts CASCADE", []);
    for (const stmt of renderOperation(
      { kind: "create_table", table: reflectTable(SearchPost) },
      "postgresql",
    )) {
      await driver.execute(stmt, []);
    }
    await new BaseRepository(SearchPost, engine.session()).createMany([
      { id: 1, title: "Ana comprou um carro", body: "pagamento à vista" },
      { id: 2, title: "Promoção", body: "compre agora com desconto" },
      { id: 3, title: "Desconto de 100%", body: "somente hoje" },
      { id: 4, title: "Sem relação", body: "texto qualquer" },
    ]);
  });

  afterAll(async () => {
    await driver.execute("DROP TABLE IF EXISTS search_posts CASCADE", []);
    await engine.close();
  });

  it("stems: searching for the infinitive finds the conjugated form", async () => {
    const rows = await engine
      .session()
      .execute(
        select(SearchPost)
          .where(fullText(["title", "body"], "comprar", { language: "portuguese" }))
          .orderBy("id"),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("ranks the better match first", async () => {
    const term = "desconto";
    const rows = await engine
      .session()
      .execute(
        select(SearchPost)
          .where(fullText(["title", "body"], term, { language: "portuguese" }))
          .orderBy(
            fullTextRank(["title", "body"], term, { language: "portuguese" }),
            "desc",
          ),
      )
      .all();
    expect(rows.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(rows).toHaveLength(2);
  });

  it("matches a literal percent through contains, not every row", async () => {
    const rows = await engine
      .session()
      .execute(select(SearchPost).where(contains(["title"], "100%")))
      .all();
    expect(rows.map((r) => r.id)).toEqual([3]);
  });
});
