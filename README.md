# ZOZU 🦊

> **Le jeu de déduction sociale, de bluff et de débat oral entre amis (3 à 12 joueurs).**

ZOZU se joue en deux modes complémentaires :
- **Pass & Play :** Tous les joueurs sur un seul smartphone que l'on se passe de main en main.
- **Salons multijoueurs en ligne :** Chaque joueur rejoint avec son propre smartphone via un code à 4 lettres ou un lien d'invitation direct.

---

## 🎮 Principe du jeu

- **Les Innocents** débattent d'un sujet imposé et cherchent à démasquer qui parmi eux a un comportement suspect.
- **Les Zozu (1 à 5 espions infiltrés)** ont reçu une mission secrète (mot imposé à placer discrètement, comportement absurde à adopter) et doivent la réussir sans se faire repérer.
- Après le débat chronométré, vote secret ou public pour éliminer les suspects !

---

## 🚀 Lancement en local

Le projet fonctionne avec **Node.js natif (>= 20)** sans aucune dépendance externe lourde.

1. **Cloner ou ouvrir le dossier :**
   ```bash
   cd ZOZU
   ```

2. **Démarrer le serveur :**
   ```bash
   npm start
   ```

3. **Jouer :**
   Ouvrez votre navigateur sur [http://localhost:3333](http://localhost:3333).

---

## ☁️ Déploiement sur Render (Web Service)

ZOZU est prêt à être déployé en 1 clic sur [Render](https://render.com) en tant que **Web Service** :

1. Créez un nouveau **Web Service** connecté à ce dépôt GitHub.
2. Configurez les paramètres suivants :
   - **Environment :** `Node`
   - **Node Version :** `20` ou supérieur
   - **Build Command :** `npm install`
   - **Start Command :** `npm start`
3. La variable d'environnement `PORT` est automatiquement gérée par Render et lue par `server.mjs`.

---

## 📱 PWA & Mobile

ZOZU est une **Progressive Web App (PWA)** installable sur iOS et Android :
- Design optimisé pour mobile (format 375 px et desktop responsive).
- Fonctionne hors-ligne pour le mode Pass & Play.
- Support du plein écran, icônes tactiles et manifest inclus.
