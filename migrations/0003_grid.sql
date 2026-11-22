-- Compteur Smarty via Leneda : puissance moyenne active consommée par quart d'heure (kW, OBIS 1-1:1.29.0).
CREATE TABLE IF NOT EXISTS grid (
  ts INTEGER PRIMARY KEY,   -- début du quart d'heure (s UTC)
  kw REAL    NOT NULL
) WITHOUT ROWID;
