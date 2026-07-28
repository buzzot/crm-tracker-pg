-- Activity participants: team users who are notified when an activity is confirmed
CREATE TABLE IF NOT EXISTS activity_participants (
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, user_id)
);
