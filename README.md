# Patch : synchro temps réel + debounce des sauvegardes

## Fichiers modifiés (2 seulement)
- `cdm2026-alpha-main/artifacts/api-server/src/routes/data.ts`
- `cdm2026-alpha-main/artifacts/api-server/public/index.html`

## Comment appliquer
Écrase simplement ces deux fichiers dans ton repo GitHub (mêmes chemins), commit, push.
Render redéploiera automatiquement. Aucun changement de schéma DB requis.

## Ce qui a changé

### 1. Synchro temps réel (le problème initial : "faut actualiser à la main")
- Nouvelle route `GET /api/data/version` : renvoie juste un timestamp de la
  dernière modif (requête minuscule), au lieu de renvoyer tous les profils.
- `initSSE()` se reconnecte automatiquement en cas de coupure de connexion.
- **Bug corrigé** : la synchro (SSE + poll) n'était démarrée qu'après un login
  frais (`_enterApp`), jamais quand la session était juste restaurée au
  rechargement de la page (`checkSession`) — le cas le plus courant. C'était
  la cause principale du "ça ne se met jamais à jour tout seul".
- Poll léger de la version toutes les 6s + poll complet de secours toutes les 60s.

### 2. Debounce des sauvegardes en DB (optimisation demandée ensuite)
- Avant : chaque frappe dans un champ score déclenchait une requête PUT
  complète vers la DB (le profil entier, à chaque caractère tapé).
- Maintenant : le localStorage est toujours mis à jour instantanément, mais
  l'écriture en base est différée de 1s après la dernière frappe — donc
  une seule requête DB si tu tapes plusieurs chiffres à la suite au lieu
  d'une par caractère.
- Un timer de debounce **par profil** (pas un seul global) : changer de
  profil juste après une saisie n'écrase pas la sauvegarde en attente du
  profil précédent.
- Filet de sécurité (`beforeunload` / `visibilitychange`) : si tu fermes ou
  masques l'onglet moins de 600ms après une saisie, la sauvegarde en attente
  est envoyée immédiatement (avec `keepalive: true` pour survivre à la
  fermeture de la page) au lieu d'être perdue.

## Mise à jour (délais allongés pour réduire encore la charge)
- Poll léger `/api/data/version` : 3s -> **6s**
- Poll complet de secours : 30s -> **60s** (pur filet de sécurité en cas
  d'échec simultané du SSE ET du poll léger — un scénario rare, donc sa
  fréquence peut être basse sans impact réel)
- Debounce des écritures DB : 600ms -> **1s**

## Fix : perte de focus en saisissant un score de phase finale
- `saveKOScore()` re-rendait tout le DOM de la phase finale à CHAQUE frappe
  (bug préexistant, indépendant de ce patch) → le champ en cours de saisie
  était détruit et recréé sans focus. Le re-rendu est maintenant débouncé
  (500ms après la dernière frappe) pour les champs texte ; le clic sur le
  bouton "vainqueur aux tirs au but" reste instantané (pas de champ texte,
  pas de risque de focus).
- Garde supplémentaire (`_isEditingSensitiveField`) : les mises à jour reçues
  en arrière-plan (SSE, poll) ne redessinent plus l'écran si un champ de
  score/buteur est activement en cours de saisie — elles se contentent de
  mettre à jour les données en mémoire, l'affichage se rafraîchit tout seul
  au cycle suivant (max 6s) dès que le champ perd le focus.

## Vrai fix (pas juste un contournement) : préservation du focus/curseur
Remplace la mitigation précédente (retarder/sauter le rendu) par une
correction générique du défaut de fond :
- Ajout d'un attribut `data-field-key` stable sur les 4 champs de score
  concernés (groupes h/a, phase finale h/a) — seule modification des templates,
  aucune logique de sauvegarde touchée.
- Nouvelle fonction générique `_withFocusPreserved(renderFn)` : mémorise le
  champ focalisé + la position du curseur avant un rendu, exécute le rendu,
  puis restaure le focus/curseur sur le nouvel élément équivalent après coup.
- Utilisée partout où un rendu peut interrompre une saisie (le rendu propre de
  `saveKOScore`, ET les rendus déclenchés par SSE/poll via `_renderAfterSync`).
Résultat : plus aucun rendu, quel qu'en soit le déclencheur, ne peut te faire
perdre le focus pendant que tu tapes — au lieu de simplement réduire la
fréquence à laquelle ça pouvait arriver.
