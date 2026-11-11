CREATE TABLE IF NOT EXISTS user_share_offer (
  user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  offered_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('offered','opened','dismissed'))
);
