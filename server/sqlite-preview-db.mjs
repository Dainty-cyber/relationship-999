// Local preview/test adapter only; production uses the Sites-managed D1 binding.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createPreviewDatabase(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const invoke = (sql, args, type) => {
    const statement = db.prepare(sql);
    if (type === 'first') return statement.get(...args) ?? null;
    if (type === 'all') return { results: statement.all(...args), success: true };
    const result = statement.run(...args);
    return { success: true, meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql, args = []) => ({
    sql, args,
    bind(...values) { return prepare(sql, values); },
    async first() { return invoke(sql, args, 'first'); },
    async all() { return invoke(sql, args, 'all'); },
    async run() { return invoke(sql, args, 'run'); }
  });
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const values = statements.map(statement => invoke(statement.sql, statement.args, 'run'));
        db.exec('COMMIT'); return values;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); }
  };
}
