-- The certificate series starts at INVLJA4447.
--
-- Floors the counter at 4446-already-used (so the next value is 4447) and, where
-- certificates already exist, moves it past the highest code actually issued.
-- Written as a MAX over the issued codes rather than a fixed number so it is
-- correct on a fresh database and on one already carrying certificates, and so
-- re-running it can never hand out a code twice.
SELECT setval(
  'certificate_code_seq',
  GREATEST(
    4446,
    COALESCE(
      (SELECT MAX(substring(certificate_code from '^INVLJA([0-9]+)$')::bigint)
         FROM certificates
        WHERE certificate_code ~ '^INVLJA[0-9]+$'),
      0
    )
  ),
  true
);
