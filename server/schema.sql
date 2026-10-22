CREATE TABLE pair_rooms (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pair_rooms_expiry_idx ON pair_rooms (expires_at);
CREATE TABLE pair_results (
  room_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer_a TEXT NOT NULL,
  answer_b TEXT NOT NULL,
  revealed_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, round_id)
);
CREATE INDEX pair_results_room_idx ON pair_results (room_id, revealed_at);
CREATE TABLE pair_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
