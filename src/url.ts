/**
 * Querium — database URL parsing & dialect detection.
 *
 * Mirrors SQLAlchemy's `make_url`: a single connection string identifies the
 * dialect (and optional driver), so switching databases is just swapping the
 * URL — `sqlite://./app.db` ↔ `postgresql://user:pass@host/db`.
 *
 * The driver suffix (`postgresql+pg`, `sqlite+better-sqlite3`, or SQLAlchemy's
 * async flavors like `postgresql+asyncpg`) is parsed out and ignored for dialect
 * detection, so URLs copied from a Python service still work here.
 */

/** A database dialect Querium can target. */
export type Dialect = "sqlite" | "postgresql";

/** A parsed database URL, dialect-neutral. */
export interface ParsedDatabaseUrl {
  /** The detected dialect. */
  readonly dialect: Dialect;
  /** Driver after the `+` in the scheme (e.g. `better-sqlite3`), or `null`. */
  readonly driver: string | null;
  /** Host (PostgreSQL), or `null` for SQLite. */
  readonly host: string | null;
  /** Port, or `null`. */
  readonly port: number | null;
  /** Username, or `null`. */
  readonly user: string | null;
  /** Password, or `null`. */
  readonly password: string | null;
  /** Database name (PostgreSQL) or file path (SQLite). `:memory:` for in-memory. */
  readonly database: string | null;
  /** Extra query-string options (`?sslmode=require`). */
  readonly options: Readonly<Record<string, string>>;
  /** The original URL, untouched. */
  readonly raw: string;
}

/** Raised when a URL cannot be parsed or its dialect is unsupported. */
export class InvalidDatabaseUrl extends Error {
  constructor(url: string, reason: string) {
    super(`Invalid database URL ${JSON.stringify(url)}: ${reason}`);
    this.name = "InvalidDatabaseUrl";
  }
}

/** Map a scheme's base name to a Querium dialect. */
const DIALECT_ALIASES: Readonly<Record<string, Dialect>> = {
  sqlite: "sqlite",
  sqlite3: "sqlite",
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
};

/** Split `"postgresql+asyncpg"` into `["postgresql", "asyncpg"]`. */
function splitScheme(scheme: string): { base: string; driver: string | null } {
  const plus = scheme.indexOf("+");
  if (plus === -1) return { base: scheme.toLowerCase(), driver: null };
  return {
    base: scheme.slice(0, plus).toLowerCase(),
    driver: scheme.slice(plus + 1) || null,
  };
}

/** Decode a URL component, leaving it untouched if it is not encoded. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a SQLite URL. Forms supported (SQLAlchemy-compatible):
 *   - `sqlite://:memory:` / `sqlite::memory:` → in-memory
 *   - `sqlite:///relative/path.db` → relative path
 *   - `sqlite:////absolute/path.db` → absolute path
 *   - `sqlite://./app.db` / `sqlite:app.db` → relative path (convenience)
 */
function parseSqlite(
  raw: string,
  driver: string | null,
  rest: string,
): ParsedDatabaseUrl {
  let database: string;
  if (rest.endsWith(":memory:")) {
    database = ":memory:";
  } else if (rest.startsWith("///")) {
    // sqlite:///rel → "rel" ; sqlite:////abs → "/abs"
    database = rest.slice(3) || ":memory:";
  } else if (rest.startsWith("//")) {
    database = rest.slice(2) || ":memory:";
  } else {
    database = rest || ":memory:";
  }
  return {
    dialect: "sqlite",
    driver,
    host: null,
    port: null,
    user: null,
    password: null,
    database: decode(database),
    options: {},
    raw,
  };
}

/** Parse a PostgreSQL URL via the WHATWG URL parser (normalize scheme first). */
function parsePostgres(
  raw: string,
  driver: string | null,
  rest: string,
): ParsedDatabaseUrl {
  // Rebuild with a clean scheme so the WHATWG URL parser accepts it.
  let parsed: URL;
  try {
    parsed = new URL(`postgresql:${rest}`);
  } catch {
    throw new InvalidDatabaseUrl(raw, "could not parse host/credentials");
  }
  const database = decode(parsed.pathname.replace(/^\//, "")) || null;
  const options: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) options[key] = value;
  return {
    dialect: "postgresql",
    driver,
    host: parsed.hostname || null,
    port: parsed.port ? Number(parsed.port) : null,
    user: parsed.username ? decode(parsed.username) : null,
    password: parsed.password ? decode(parsed.password) : null,
    database,
    options,
    raw,
  };
}

/**
 * Parse a database URL into its dialect and connection parts.
 *
 * @param url A connection string, e.g. `"postgresql://app:app@localhost/app"`
 *   or `"sqlite:///app.db"`. An async driver suffix (`+asyncpg`, `+aiosqlite`)
 *   is accepted and ignored for dialect detection.
 * @returns The parsed, dialect-neutral connection descriptor.
 * @throws InvalidDatabaseUrl When the URL has no scheme or an unknown dialect.
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const schemeEnd = url.indexOf(":");
  if (schemeEnd === -1) {
    throw new InvalidDatabaseUrl(
      url,
      "missing scheme (expected e.g. sqlite:// or postgresql://)",
    );
  }
  const { base, driver } = splitScheme(url.slice(0, schemeEnd));
  const dialect = DIALECT_ALIASES[base];
  if (!dialect) {
    throw new InvalidDatabaseUrl(url, `unknown dialect ${JSON.stringify(base)}`);
  }
  const rest = url.slice(schemeEnd + 1);
  return dialect === "sqlite"
    ? parseSqlite(url, driver, rest)
    : parsePostgres(url, driver, rest);
}

/** Detect just the dialect of a URL, ignoring the rest. */
export function detectDialect(url: string): Dialect {
  return parseDatabaseUrl(url).dialect;
}
