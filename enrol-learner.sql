-- Enrol learner@invensis.test in TRN-2026-0001 on the remote DB. Idempotent.

-- 1. Ensure a participant record exists for the learner, linked to their user account
INSERT INTO participants (user_id, name, email)
SELECT u.id, u.name, u.email
FROM users u
WHERE u.email = 'learner@invensis.test'
ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id;

-- 2. Insert a confirmed enrolment (partial unique index makes this a no-op if it already exists)
INSERT INTO enrolments (training_id, participant_id, status)
SELECT '019f0287-fcab-73ba-ae91-30ae5a59c220', p.id, 'confirmed'
FROM participants p
WHERE p.email = 'learner@invensis.test'
ON CONFLICT DO NOTHING;

-- 3. Refresh the training's enrolled_count from live confirmed rows
UPDATE training_ids t
SET enrolled_count = (
  SELECT count(*) FROM enrolments e
  WHERE e.training_id = t.id AND e.status = 'confirmed'
), updated_at = now()
WHERE t.code = 'TRN-2026-0001';

-- verify
SELECT e.status, p.email, p.user_id, t.code, t.enrolled_count
FROM enrolments e
JOIN participants p ON p.id = e.participant_id
JOIN training_ids t ON t.id = e.training_id
WHERE t.code = 'TRN-2026-0001' AND p.email = 'learner@invensis.test';
