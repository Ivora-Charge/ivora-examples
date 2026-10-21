# check-migrations: the 10-30 rule for Supabase

A static check for Supabase migrations, shared by every template in this repository that has a database. Templates keep their runtime code separate; this CI tool is the one shared piece (see [docs/conventions.md](../../docs/conventions.md#supabase-and-the-10-30-rule)).

```sh
node tools/check-migrations <migrations dir> [--schema <name>]...
```

It needs Node.js 22 and no `npm install`. It exits `0` when every `.sql` file follows the rule, `1` with one line per problem, and `2` on a usage error. `--schema` adds schemas exposed through the Data API besides `public`.

## Why

Supabase serves the `public` schema through its Data API to anyone with the project's anon key. Its default privileges give the `anon` and `authenticated` roles every privilege on new tables and `EXECUTE` on new functions, and Postgres gives `PUBLIC` `EXECUTE` on every function. A table without RLS, or a function left with those defaults, can be read or called from a browser. A `SECURITY DEFINER` function also runs with its owner's rights, so it must not resolve names through a caller-controlled `search_path`.

## The rules

| Object                             | Must                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table in `public`                  | `alter table … enable row level security` and `revoke all on … from public, anon, authenticated`, in the same file. A partial revoke (`revoke select …`) does not count. This includes a table made by `select … into` and one moved in with `alter table … set schema public`.                                                                                                                                                                                                                                                                                                                                               |
| View                               | `with (security_invoker = true)` and the same `revoke all`, and never `alter view … set (security_invoker = false)` or `reset (security_invoker)`. A materialized view can't have RLS: revoke all and never grant it to browser roles.                                                                                                                                                                                                                                                                                                                                                                                        |
| Grant to `anon` or `authenticated` | Explicit privileges (`select`, `insert`, `update`, `delete`, optionally per column), never `ALL`, each backed by an RLS policy for that role and command. No grants on all tables in a schema.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Function or procedure in `public`  | `revoke execute on function …(…) from public, anon, authenticated` after it is created, in the same file. It may then be granted to roles the migration names (for example `authenticated` or `service_role`), never to `anon` or `PUBLIC`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `SECURITY DEFINER` function        | `set search_path` (for example `set search_path = ''`, with schema-qualified names inside), also after `alter function`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Other grants to browser roles      | On a schema, type or domain only `usage`; on a sequence only `usage` and `select`; nothing on a database, language, large object, foreign object, tablespace or parameter.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Anything                           | No `grant … to public`, no `alter default privileges … grant`, no `disable row level security`, no role grants to `anon`/`authenticated`, nothing owned by them, nothing but tables moved into `public` with `set schema`, extensions created `with schema` outside `public`, and no DDL or dynamic SQL (`execute`) where the check can't read it: inside a `do $$ … $$` block, or in a function the migrations create and then run (with `select f()`, `call`, `perform` or a trigger), also through another function. Calls to `cron.schedule`, `dblink` and `pg_background_launch`, which run SQL from a string, fail too. |
| Any other statement                | Fails with `unrecognised statement: review it or add a rule`, unless it is on the short list of statements that can't create, expose or grant anything: transactions, `set`/`reset` (not `set role`), queries and DML, indexes, triggers, types and domains, drops, revokes and comments.                                                                                                                                                                                                                                                                                                                                     |

A minimal safe table and function:

```sql
create table public.notes (id uuid primary key, owner uuid not null, body text);
alter table public.notes enable row level security;
revoke all on public.notes from public, anon, authenticated;
grant select (id, body) on public.notes to authenticated;
create policy "Own notes" on public.notes for select to authenticated using (owner = auth.uid());

create function public.count_notes() returns bigint
  language sql security definer set search_path = '' as $$ select count(*) from public.notes $$;
revoke execute on function public.count_notes() from public, anon, authenticated;
grant execute on function public.count_notes() to service_role;
```

## What it guarantees, and its limits

Every statement is either one the rules above check, or on the short list of statements that can't create, expose or grant anything; anything else fails as unrecognised. So a new kind of statement fails until someone reviews it and adds a rule, rather than passing unread.

The parser reads statement shapes, not the full SQL grammar, so it can be stricter than Postgres, never looser, for the statements it reads: revokes must sit in the same file as the object, and overloads are told apart by their number of arguments, so overloads with the same count need a revoke each. Comments and string literals are ignored; function bodies are read only to see whether they run DDL when a migration calls them. It does not read code from outside the migrations, such as functions an extension provides (apart from the SQL-from-a-string calls above), and it checks migrations, not a live database. The tests below prove the rules against Postgres.

## Tests

```sh
cd tools/check-migrations
npm ci
npm test
```

The tests run in CI (`.github/workflows/tools.yml`). Besides unit tests for every rule, `test/pglite.test.mjs` sets up an in-process Postgres ([PGlite](https://pglite.dev)) with Supabase's roles and its default privileges on tables and functions. It shows that `anon` can't read or call anything in a migration the check passes, and that it can in each unsafe example the check fails.

## Using it in a template

A template's workflow runs it on the template's migrations, and lists `tools/check-migrations/**` in its `paths` filter so a change to the check re-runs the template's CI:

```yaml
- run: node ../tools/check-migrations supabase/migrations
```

**Forking a single template:** copy `tools/check-migrations` into your repository as well, keeping the same layout (the template folder and `tools/` side by side), or change the path in the template's `check:migrations` script and workflow step.
