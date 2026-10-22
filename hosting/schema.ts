import { integer, sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const pairRooms = sqliteTable('pair_rooms', {
  id: text('id').primaryKey().notNull(),
  state: text('state').notNull(),
  revision: integer('revision').notNull().default(0),
  expiresAt: integer('expires_at').notNull()
}, table => [index('pair_rooms_expiry_idx').on(table.expiresAt)]);

export const pairResults = sqliteTable('pair_results', {
  roomId: text('room_id').notNull(), roundId: text('round_id').notNull(),
  questionId: text('question_id').notNull(), answerA: text('answer_a').notNull(),
  answerB: text('answer_b').notNull(), revealedAt: integer('revealed_at').notNull()
}, table => [primaryKey({ columns: [table.roomId, table.roundId] }), index('pair_results_room_idx').on(table.roomId, table.revealedAt)]);

export const pairLimits = sqliteTable('pair_limits', {
  bucket: text('bucket').primaryKey().notNull(), count: integer('count').notNull().default(0), expiresAt: integer('expires_at').notNull()
});
