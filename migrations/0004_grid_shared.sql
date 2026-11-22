-- Part de la consommation couverte par une communauté énergétique (Leneda, OBIS 1-65:1.29.2 + 1-65:1.29.4, kW moyen du quart d'heure).
-- NULL = partage pas encore publié par Leneda (calculé avec environ un mois de retard).
ALTER TABLE grid ADD COLUMN sh REAL;
