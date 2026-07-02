import { describe, expect, it } from "vitest";
import { InvalidDatabaseUrl, detectDialect, parseDatabaseUrl } from "../src/index.js";

describe("parseDatabaseUrl — SQLite", () => {
  it("parses an in-memory database", () => {
    const u = parseDatabaseUrl("sqlite://:memory:");
    expect(u.dialect).toBe("sqlite");
    expect(u.database).toBe(":memory:");
  });

  it("parses a relative path (three slashes)", () => {
    const u = parseDatabaseUrl("sqlite:///app.db");
    expect(u.dialect).toBe("sqlite");
    expect(u.database).toBe("app.db");
  });

  it("parses an absolute path (four slashes)", () => {
    const u = parseDatabaseUrl("sqlite:////var/data/app.db");
    expect(u.database).toBe("/var/data/app.db");
  });

  it("strips an async driver suffix", () => {
    const u = parseDatabaseUrl("sqlite+aiosqlite:///app.db");
    expect(u.dialect).toBe("sqlite");
    expect(u.driver).toBe("aiosqlite");
    expect(u.database).toBe("app.db");
  });
});

describe("parseDatabaseUrl — PostgreSQL", () => {
  it("parses host, port, credentials and database", () => {
    const u = parseDatabaseUrl("postgresql://app:secret@localhost:5432/mydb");
    expect(u.dialect).toBe("postgresql");
    expect(u.host).toBe("localhost");
    expect(u.port).toBe(5432);
    expect(u.user).toBe("app");
    expect(u.password).toBe("secret");
    expect(u.database).toBe("mydb");
  });

  it("accepts the postgres:// and pg:// aliases", () => {
    expect(parseDatabaseUrl("postgres://h/db").dialect).toBe("postgresql");
    expect(parseDatabaseUrl("pg://h/db").dialect).toBe("postgresql");
  });

  it("strips an async driver suffix and keeps query options", () => {
    const u = parseDatabaseUrl("postgresql+asyncpg://app@db/mydb?sslmode=require");
    expect(u.dialect).toBe("postgresql");
    expect(u.driver).toBe("asyncpg");
    expect(u.options.sslmode).toBe("require");
  });
});

describe("parseDatabaseUrl — errors", () => {
  it("throws on a missing scheme", () => {
    expect(() => parseDatabaseUrl("localhost/db")).toThrow(InvalidDatabaseUrl);
  });

  it("throws on an unknown dialect", () => {
    expect(() => parseDatabaseUrl("oracle://h/db")).toThrow(InvalidDatabaseUrl);
  });

  it("parses a MySQL URL (and the mariadb alias)", () => {
    const p = parseDatabaseUrl("mysql://app:secret@localhost:3306/shop");
    expect(p.dialect).toBe("mysql");
    expect(p.host).toBe("localhost");
    expect(p.port).toBe(3306);
    expect(p.user).toBe("app");
    expect(p.password).toBe("secret");
    expect(p.database).toBe("shop");
    expect(parseDatabaseUrl("mariadb://h/db").dialect).toBe("mysql");
  });

  it("detectDialect returns just the dialect", () => {
    expect(detectDialect("sqlite:///x.db")).toBe("sqlite");
    expect(detectDialect("postgresql://h/db")).toBe("postgresql");
    expect(detectDialect("mysql://h/db")).toBe("mysql");
  });
});
