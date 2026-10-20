// Unit check for the query template in src/worker/db.ts (#4, case 29): each
// driver numbers the values its own way and leaves the SQL text alone, a ?
// inside a string literal or a jsonb operator included. Node strips the types.
// usage: node scripts/check-sql.mjs
import assert from "node:assert/strict";
import { render, sql } from "../src/worker/db.ts";

const pgMark = (n) => `$${n}`;
const d1Mark = () => "?";

const q = sql`select "id" from "note" where "id" = ${"a"} and "userId" = ${"b"}`;
assert.equal(render(q, pgMark), `select "id" from "note" where "id" = $1 and "userId" = $2`);
assert.equal(render(q, d1Mark), `select "id" from "note" where "id" = ? and "userId" = ?`);
assert.deepEqual(q.values, ["a", "b"]);

const literal = sql`select 'why?' as q, data ? 'key' as has from t where id = ${1}`;
assert.equal(render(literal, pgMark), `select 'why?' as q, data ? 'key' as has from t where id = $1`);

const none = sql`select 1`;
assert.equal(render(none, pgMark), "select 1");
assert.deepEqual(none.values, []);

const value = sql`insert into t values (${"what?"})`;
assert.equal(render(value, pgMark), "insert into t values ($1)");
assert.deepEqual(value.values, ["what?"]);

console.log("check-sql: 8 assertions passed");
