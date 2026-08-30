# Comparação case-insensitive (e a armadilha do `ilike`)

Login por username/e-mail sem diferenciar maiúsculas — e sem abrir um bypass de
autenticação no caminho.

## O problema

Username case-insensitive costuma ser garantido por um índice **funcional**:

```sql
CREATE UNIQUE INDEX admin_users_username_unique
    ON admin_users (lower(username));
```

E o lookup correspondente é `WHERE lower(username) = lower($1)`.

## ⚠️ O workaround aparente é uma armadilha

Como `ilike` existe e é "case-insensitive", a tentação é usá-lo como se fosse um
`eq`:

```ts
// ❌ NÃO faça isso num lookup de autenticação
select(AdminUser).where({ username: { ilike: probe } });
```

Testado contra um Postgres real:

```
ilike "mixedcase"  -> 1 linha
ilike "MIXEDCASE"  -> 1 linha
ilike "%"          -> 1 linha    <-- casa TODAS as linhas
```

!!! danger "`ilike` é *pattern matching*, não igualdade"

    `%` e `_` são coringas. Num lookup de autenticação, um username `"%"` casa a
    primeira linha da tabela — quem escrever esse workaround sem lembrar de
    escapar acabou de abrir um bypass de login. E `ILIKE` **não usa** o índice
    `lower(username)`: vira sequential scan.

## ✅ A solução — `ieq`

```ts
import { select } from "tempest-db-js";

const user = await session
  .execute(select(AdminUser).where({ username: { ieq: probe } }))
  .oneOrNull();
```

Compila para exatamente o que o índice funcional espera, nos três dialetos:

```sql
-- PostgreSQL
SELECT * FROM "admin_users" WHERE lower("username") = lower($1)
-- SQLite
SELECT * FROM "admin_users" WHERE lower("username") = lower(?)
-- MySQL
SELECT * FROM `admin_users` WHERE lower(`username`) = lower(?)
```

Sem coringas, sem escape, e casando o índice `lower(username)`.

```ts
select(AdminUser).where({ username: { ieq: "%" } });  // 0 linhas — é literal
```

`ieq` é um operador de string: o type-checker o rejeita em coluna numérica,
booleana ou de data, igual a `like`/`ilike`.

## Quando `ilike` ainda é o certo

`ilike` continua sendo a ferramenta correta para o que ele é: **busca por
padrão**, com coringa deliberado.

```ts
// Busca de autocompletar — o "%" é seu, e é intencional
select(Product).where({ name: { ilike: `${escapeUserInput(term)}%` } });
```

!!! tip "Regra de bolso"

    Se o valor comparado vem do usuário e você espera **igualdade**, use `ieq`.
    Se você mesmo está construindo um padrão, use `ilike` — e trate `%`/`_` do
    trecho vindo do usuário.

## Recap

- `{ ieq: valor }` → `lower(col) = lower($1)`: igualdade case-insensitive,
  portável, sem coringa, e usa índice funcional.
- `{ ilike: padrão }` → pattern matching. `%` e `_` são coringas; `"%"` casa
  tudo.
- Nunca use `ilike` para autenticação ou qualquer lookup que deveria ser
  igualdade.
