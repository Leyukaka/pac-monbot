# pac : tableau de suivi pour pompe à chaleur NIBE (myUplink)

Ce tableau montre en direct l'état d'une pompe à chaleur NIBE connectée à myUplink :
- un schéma de l'installation animé selon la fréquence du compresseur, avec le dégivrage ;
- le cycle frigorifique, les températures, les degrés-minutes et l'appoint ;
- la puissance électrique, la chaleur produite, le COP et un bilan sur 14 jours ;
- des courbes avec une frise temporelle.

Le site n'a aucune dépendance (HTML, CSS et SVG à la main). La formule gratuite de myUplink suffit, car l'historique est construit localement.

Il se déploie au choix :
- sur **Cloudflare** (Workers + D1 + cron), voir la section A ;
- sur **une VM ou un serveur** (Node ≥ 22.5 avec SQLite, ou Docker), voir la section B.

Le même `src/worker.js` sert dans les deux cas.

> Les identifiants de points (`TRACKED` dans `src/worker.js`) ont été vérifiés sur une **VVM 500 + EB101** (F2120). D'autres modèles NIBE peuvent utiliser d'autres numéros. La table `points` contient la liste complète vue par ton installation : adapte `TRACKED` et les `ID` en tête de `site/app.js` si besoin.

## 1. Accès myUplink (commun aux deux modes)

1. Va sur https://dev.myuplink.com/apps et crée une application de type **client credentials**. L'URL de callback peut rester vide.
2. Note le **Client ID** et le **Client Secret**. Ils ne vont **jamais** dans git :
   - sur Cloudflare, ils deviennent des secrets Wrangler ;
   - sur une VM, ils vont dans un fichier `.env`, déjà ignoré par git.

Le collecteur n'utilise que le scope `READSYSTEM` (lecture seule) et fait environ 3 requêtes toutes les 5 minutes. Le quota de myUplink est de 25 requêtes par minute.

## A. Déploiement Cloudflare

```sh
cp wrangler.example.jsonc wrangler.jsonc        # puis éditer le domaine
npx wrangler d1 create pac                      # copier l'ID dans wrangler.jsonc
npx wrangler d1 migrations apply pac --remote
npx wrangler secret put MYUPLINK_CLIENT_ID
npx wrangler secret put MYUPLINK_CLIENT_SECRET
npx wrangler deploy
```

La première collecte arrive dans les 5 minutes.

### Protection avec Cloudflare Access (recommandé)

Dans le dashboard, va dans **Zero Trust → Access → Applications → Add → Self-hosted** :
- **domaine** : ton sous-domaine, chemin vide pour tout couvrir, `/api/*` compris ;
- **policy** : Allow, `Emails` égal à ton adresse ;
- **connexion** : *One-time PIN*, un code reçu par e-mail. C'est la méthode intégrée, sans application OAuth à créer. Google ou GitHub sont possibles en option.

`workers_dev` reste à `false`, sinon l'adresse `*.workers.dev` contournerait Access. Une fois le site protégé, tu peux ajouter `"vars": { "SHOW_HOUSE": "1" }` pour afficher les intensités des phases de la maison (BE1 à BE3).

## B. Déploiement sur une VM ou un serveur

Avec Node ≥ 22.5 (aucun `npm install` nécessaire) :

```sh
cp .env.example .env      # remplir MYUPLINK_CLIENT_ID / SECRET
npm start                 # http://127.0.0.1:8787, base dans ./data/pac.db
```

Avec Docker ou Podman :

```sh
cp .env.example .env
docker compose up -d      # ou : podman compose up -d
```

`server/node.mjs` assure le même service que Cloudflare :
- il applique les migrations au démarrage ;
- il collecte toutes les 5 minutes (`POLL_MINUTES`) ;
- il sert `site/` avec les en-têtes de `site/_headers` ;
- il met l'API en cache 60 secondes.

Il n'y a **pas d'authentification intégrée** : le serveur écoute sur `127.0.0.1`. Pour y accéder depuis l'extérieur, au choix :
- `cloudflared tunnel` + Cloudflare Access ;
- un reverse proxy (Caddy, nginx) avec authentification ;
- seulement ton VPN ou Tailscale.

## API (GET seulement)

| Route | Contenu |
|---|---|
| `/api/now` | Dernières valeurs, compteurs sur 7 jours, alarmes (gravité, titre), état de la collecte |
| `/api/series?range=24h\|7d\|30d\|30dd\|365d\|all&pids=…` ou `from=&to=` (s UTC) | Courbes agrégées (au plus ~400 points par courbe), 12 points au maximum |
| `/api/health` | 12 dernières collectes, test de la route d'historique myUplink |

## Sécurité

- Aucun secret n'est stocké dans le code. Le jeton myUplink est mis en cache dans la base, jamais renvoyé par l'API.
- L'API ne publie ni la liste complète des points, ni les identifiants système et matériel. Les phases de la maison sont masquées sauf avec `SHOW_HOUSE=1`, car elles révèlent la présence des occupants.
- Sur Cloudflare, chaque IP est limitée à 60 requêtes par minute. Un 429 de myUplink met la collecte en pause selon `RateLimit-Reset`.
- La page applique une CSP stricte (`site/_headers`) et utilise des polices locales, sans CDN.
- Les longues périodes sont lues dans `readings_h`, qui contient les agrégats horaires.

## Divers

- Pour voir le schéma sans attendre que le compresseur tourne, ajoute `?demo=30|64|110|defrost` à l'URL. Cela ne change que l'affichage.
- L'énergie provient du journal NIBE : 32486 pour la puissance instantanée, 3249x pour les bilans de l'heure passée. Sans ces points, l'estimation de repli est de 40 W par Hz.
- La route d'historique de myUplink renvoie 403 en formule gratuite : le passé n'est pas importable sans Premium.
- Ce projet n'est pas affilié à NIBE ni à myUplink.

Licence MIT.
