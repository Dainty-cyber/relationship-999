// All multi-statement writes are D1 batches. Revision checks serialize the two
// participants; failed compare-and-swap writes never create answer history.
export function createD1Repository(binding) {
  const db = binding.withSession ? binding.withSession('first-primary') : binding;
  return {
    async load(id) {
      const row = await db.prepare('SELECT id, state, revision, expires_at FROM pair_rooms WHERE id = ?').bind(id).first();
      return row ? { id: row.id, state: JSON.parse(row.state), revision: row.revision, expiresAt: row.expires_at } : null;
    },
    async create(row) {
      const result = await db.prepare('INSERT OR IGNORE INTO pair_rooms (id, state, revision, expires_at) VALUES (?, ?, ?, ?)').bind(row.id, JSON.stringify(row.state), row.revision, row.expiresAt).run();
      return result.meta.changes === 1;
    },
    async save(row, expectedRevision, result) {
      const statements = [];
      if (result) statements.push(db.prepare('INSERT OR IGNORE INTO pair_results (room_id, round_id, question_id, answer_a, answer_b, revealed_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pair_rooms WHERE id = ? AND revision = ?)').bind(row.id, result.roundId, result.questionId, JSON.stringify(result.a), JSON.stringify(result.b), result.revealedAt, row.id, expectedRevision));
      statements.push(db.prepare('UPDATE pair_rooms SET state = ?, revision = ? WHERE id = ? AND revision = ?').bind(JSON.stringify(row.state), row.revision, row.id, expectedRevision));
      const results = await db.batch(statements);
      return results.at(-1).meta.changes === 1;
    },
    async history(id) {
      const result = await db.prepare('SELECT round_id, question_id, answer_a, answer_b, revealed_at FROM pair_results WHERE room_id = ? ORDER BY revealed_at DESC, rowid DESC LIMIT 1000').bind(id).all();
      return result.results.map(row => ({ roundId: row.round_id, questionId: row.question_id, a: JSON.parse(row.answer_a), b: JSON.parse(row.answer_b), revealedAt: row.revealed_at }));
    },
    async remove(id) {
      await db.batch([
        db.prepare('DELETE FROM pair_results WHERE room_id = ?').bind(id),
        db.prepare('DELETE FROM pair_rooms WHERE id = ?').bind(id)
      ]);
    },
    async cleanup(time) {
      await db.batch([
        db.prepare('DELETE FROM pair_results WHERE room_id IN (SELECT id FROM pair_rooms WHERE expires_at <= ? LIMIT 20)').bind(time),
        db.prepare('DELETE FROM pair_rooms WHERE id IN (SELECT id FROM pair_rooms WHERE expires_at <= ? LIMIT 20)').bind(time),
        db.prepare('DELETE FROM pair_limits WHERE expires_at <= ?').bind(time)
      ]);
    },
    async limit(key, expiresAt, maximum) {
      const result = await db.prepare('INSERT INTO pair_limits (bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count').bind(key, expiresAt).first();
      return result.count <= maximum;
    }
  };
}
