-- Agrégats horaires : les longues périodes lisent ici au lieu des relevés bruts (quota D1).
CREATE TABLE IF NOT EXISTS readings_h (
  ts  INTEGER NOT NULL,   -- début de l'heure (s UTC)
  pid TEXT    NOT NULL,
  a   REAL    NOT NULL,   -- moyenne
  lo  REAL    NOT NULL,
  hi  REAL    NOT NULL,
  n   INTEGER NOT NULL,   -- nombre de relevés
  PRIMARY KEY (ts, pid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS readings_h_pid_ts ON readings_h (pid, ts);

-- Reprise de l'existant.
INSERT OR REPLACE INTO readings_h (ts, pid, a, lo, hi, n)
  SELECT (ts / 3600) * 3600, pid, AVG(value), MIN(value), MAX(value), COUNT(*) FROM readings GROUP BY (ts / 3600), pid;
