-- Un relevé = une valeur d'un point myUplink à un instant (secondes UTC).
CREATE TABLE IF NOT EXISTS readings (
  ts    INTEGER NOT NULL,
  pid   TEXT    NOT NULL,   -- parameterId myUplink
  value REAL    NOT NULL,
  PRIMARY KEY (ts, pid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS readings_pid_ts ON readings (pid, ts);

-- Description des points, mise à jour à chaque collecte.
CREATE TABLE IF NOT EXISTS points (
  pid      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  unit     TEXT,
  category TEXT,
  device   TEXT,
  last_ts  INTEGER,
  last_val REAL,
  last_str TEXT
);

-- Journal des collectes (diagnostic du collecteur lui-même).
CREATE TABLE IF NOT EXISTS polls (
  ts     INTEGER PRIMARY KEY,
  ok     INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  detail TEXT
);

-- Petites valeurs du collecteur : jeton (expire en 1 h), IDs système, alarmes.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
