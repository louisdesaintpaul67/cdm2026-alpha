import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, settingsTable, profilesDataTable, sessionsTable } from "@workspace/db";
import { eq, ne } from "drizzle-orm";
import { requireAdmin, AuthRequest } from "../middlewares/auth";
import { broadcastEvent } from "./data";

const GENERIC_PASSWORD = "2026";

/**
 * Extrait l'emoji et le pseudo depuis un champ name formaté "emoji pseudo"
 * Ex: "🐉 Sah Muel" → { emoji: "🐉", pseudo: "Sah Muel" }
 */
function parseProfileName(name: string): { emoji: string; pseudo: string } {
  if (!name || typeof name !== "string") return { emoji: "😎", pseudo: "Joueur" };
  const trimmed = name.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const possibleEmoji = trimmed.slice(0, spaceIdx);
    const possiblePseudo = trimmed.slice(spaceIdx + 1).trim();
    // Si le premier token ressemble à un emoji (non-ASCII) et le pseudo est valide
    if (/\p{Emoji}/u.test(possibleEmoji) && possiblePseudo.length >= 2) {
      return { emoji: possibleEmoji, pseudo: possiblePseudo };
    }
  }
  // Pas d'emoji détecté — utiliser le nom tel quel
  return { emoji: "😎", pseudo: trimmed.length >= 2 ? trimmed : "Joueur" };
}

const router = Router();

router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      pseudo: usersTable.pseudo,
      emoji: usersTable.emoji,
      role: usersTable.role,
      passwordClear: usersTable.passwordClear,
      pending: usersTable.pending,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);
  res.json({ users });
});

router.delete("/admin/users/:id", requireAdmin, async (req: AuthRequest, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  if (id === req.userId) {
    res.status(400).json({ error: "Impossible de supprimer votre propre compte." });
    return;
  }

  const rows = await db.select({ pseudo: usersTable.pseudo }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (rows.length === 0) { res.status(404).json({ error: "Utilisateur introuvable" }); return; }
  const { pseudo } = rows[0];

  await db.delete(sessionsTable).where(eq(sessionsTable.userId, id));
  await db.delete(profilesDataTable).where(eq(profilesDataTable.profileKey, pseudo));
  await db.delete(usersTable).where(eq(usersTable.id, id));

  res.json({ success: true });
});

router.put("/admin/users/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  await db.update(usersTable).set({ pending: false }).where(eq(usersTable.id, id));
  res.json({ success: true });
});

router.put("/admin/users/:id/password", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const { password } = req.body ?? {};
  if (!password || typeof password !== "string" || password.length < 4) {
    res.status(400).json({ error: "Mot de passe trop court (4 caractères minimum)." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(usersTable).set({ passwordHash, passwordClear: password }).where(eq(usersTable.id, id));

  res.json({ success: true });
});

router.get("/admin/settings", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(settingsTable);
  const settings: Record<string, string> = {};
  for (const row of rows) { settings[row.key] = row.value; }
  res.json({ settings });
});

router.put("/admin/settings", requireAdmin, async (req, res): Promise<void> => {
  const { key, value } = req.body ?? {};
  if (!key || typeof key !== "string" || !value || typeof value !== "string") {
    res.status(400).json({ error: "Clé et valeur requises." });
    return;
  }

  const existing = await db.select({ id: settingsTable.id }).from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
  if (existing.length > 0) {
    await db.update(settingsTable).set({ value }).where(eq(settingsTable.key, key));
  } else {
    await db.insert(settingsTable).values({ key, value });
  }

  res.json({ success: true });
});

router.put("/admin/locks/all", requireAdmin, async (req, res): Promise<void> => {
  const { type, locked } = req.body ?? {};
  const allowed = ["poulesLocked", "knockoutLocked", "buteurLocked"];
  if (!allowed.includes(type)) {
    res.status(400).json({ error: "Type de verrou invalide." });
    return;
  }

  const allUsers = await db.select({ id: usersTable.id, pseudo: usersTable.pseudo }).from(usersTable);
  for (const user of allUsers) {
    const rows = await db.select().from(profilesDataTable).where(eq(profilesDataTable.profileKey, user.pseudo)).limit(1);
    if (rows.length > 0) {
      const updatedData = { ...(rows[0].data as Record<string, unknown>), [type]: locked };
      await db.update(profilesDataTable).set({ data: updatedData, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, user.pseudo));
    } else {
      await db.insert(profilesDataTable).values({ profileKey: user.pseudo, userId: user.id, data: { [type]: locked } });
    }
  }

  const iaRows = await db.select().from(profilesDataTable).where(eq(profilesDataTable.profileKey, "ia")).limit(1);
  if (iaRows.length > 0) {
    const updatedData = { ...(iaRows[0].data as Record<string, unknown>), [type]: locked };
    await db.update(profilesDataTable).set({ data: updatedData, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, "ia"));
  } else {
    await db.insert(profilesDataTable).values({ profileKey: "ia", userId: null, data: { [type]: locked } });
  }

  const settingKey = `global_${type}`;
  const settingValue = locked ? "true" : "false";
  const existingSetting = await db.select({ id: settingsTable.id }).from(settingsTable).where(eq(settingsTable.key, settingKey)).limit(1);
  if (existingSetting.length > 0) {
    await db.update(settingsTable).set({ value: settingValue }).where(eq(settingsTable.key, settingKey));
  } else {
    await db.insert(settingsTable).values({ key: settingKey, value: settingValue });
  }

  broadcastEvent({ type: "lock-update" });
  res.json({ success: true });
});

router.put("/admin/users/:id/locks", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const { type, locked } = req.body ?? {};
  const allowed = ["poulesLocked", "knockoutLocked", "buteurLocked"];
  if (!allowed.includes(type)) {
    res.status(400).json({ error: "Type de verrou invalide." });
    return;
  }

  const userRows = await db.select({ pseudo: usersTable.pseudo }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (userRows.length === 0) { res.status(404).json({ error: "Utilisateur introuvable" }); return; }
  const { pseudo } = userRows[0];

  const rows = await db.select().from(profilesDataTable).where(eq(profilesDataTable.profileKey, pseudo)).limit(1);
  if (rows.length > 0) {
    const updatedData = { ...(rows[0].data as Record<string, unknown>), [type]: locked };
    await db.update(profilesDataTable).set({ data: updatedData, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, pseudo));
  } else {
    await db.insert(profilesDataTable).values({ profileKey: pseudo, userId: id, data: { [type]: locked } });
  }

  broadcastEvent({ type: "lock-update" });
  res.json({ success: true });
});


router.put("/admin/profiles/:key/locks", requireAdmin, async (req, res): Promise<void> => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  if (!["real", "ia"].includes(key)) {
    res.status(400).json({ error: "Clé invalide (real/ia uniquement)" });
    return;
  }
  const { type, locked } = req.body ?? {};
  const allowed = ["poulesLocked", "knockoutLocked", "buteurLocked"];
  if (!allowed.includes(type)) {
    res.status(400).json({ error: "Type de verrou invalide." });
    return;
  }
  const rows = await db.select().from(profilesDataTable).where(eq(profilesDataTable.profileKey, key)).limit(1);
  if (rows.length > 0) {
    const updatedData = { ...(rows[0].data as Record<string, unknown>), [type]: locked };
    await db.update(profilesDataTable).set({ data: updatedData, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, key));
  } else {
    await db.insert(profilesDataTable).values({ profileKey: key, userId: null, data: { [type]: locked } });
  }
  broadcastEvent({ type: "lock-update" });
  res.json({ success: true });
});

router.post("/admin/force-idle", requireAdmin, async (req, res): Promise<void> => {
  broadcastEvent({ type: "force-idle" });
  res.json({ success: true });
});

router.put("/admin/users/:id/pseudo", requireAdmin, async (req: AuthRequest, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const { pseudo: newPseudo } = req.body ?? {};
  if (!newPseudo || typeof newPseudo !== "string" || newPseudo.trim().length < 2) {
    res.status(400).json({ error: "Pseudo invalide (2 caractères minimum)." });
    return;
  }
  const trimmed = newPseudo.trim();
  const lower = trimmed.toLowerCase();
  if (["real", "ia"].includes(lower) || lower === "admin") {
    res.status(400).json({ error: "Ce pseudo est réservé." });
    return;
  }

  const userRows = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (userRows.length === 0) { res.status(404).json({ error: "Utilisateur introuvable" }); return; }
  const current = userRows[0];

  if (current.pseudo === trimmed) {
    res.json({ success: true, pseudo: trimmed });
    return;
  }

  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.pseudo, trimmed)).limit(1);
  if (existing.length > 0 && current.pseudo.toLowerCase() !== lower) {
    res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    return;
  }

  const profileRows = await db.select().from(profilesDataTable).where(eq(profilesDataTable.profileKey, current.pseudo)).limit(1);
  if (profileRows.length > 0) {
    await db.update(profilesDataTable).set({ profileKey: trimmed, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, current.pseudo));
  }

  await db.update(usersTable).set({ pseudo: trimmed }).where(eq(usersTable.id, id));

  res.json({ success: true, pseudo: trimmed });
});

// ── IMPORT COMPÉTITION ─────────────────────────────────────────────────────
// Remplace les résultats real/ia, supprime tous les comptes sauf l'admin courant,
// crée les nouveaux comptes depuis les profils importés (mdp générique 2026).
router.post("/admin/import/competition", requireAdmin, async (req: AuthRequest, res): Promise<void> => {
  const { profiles } = req.body ?? {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    res.status(400).json({ error: "Données invalides : profiles manquant." });
    return;
  }

  const adminId = req.userId!;
  const passwordHash = await bcrypt.hash(GENERIC_PASSWORD, 12);

  // 1. Remplacer le profil 'real'
  if (profiles["real"] && typeof profiles["real"] === "object") {
    const existing = await db.select({ id: profilesDataTable.id }).from(profilesDataTable).where(eq(profilesDataTable.profileKey, "real")).limit(1);
    if (existing.length > 0) {
      await db.update(profilesDataTable).set({ data: profiles["real"], updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, "real"));
    } else {
      await db.insert(profilesDataTable).values({ profileKey: "real", userId: null, data: profiles["real"] });
    }
  }

  // 2. Remplacer le profil 'ia'
  if (profiles["ia"] && typeof profiles["ia"] === "object") {
    const existing = await db.select({ id: profilesDataTable.id }).from(profilesDataTable).where(eq(profilesDataTable.profileKey, "ia")).limit(1);
    if (existing.length > 0) {
      await db.update(profilesDataTable).set({ data: profiles["ia"], updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, "ia"));
    } else {
      await db.insert(profilesDataTable).values({ profileKey: "ia", userId: null, data: profiles["ia"] });
    }
  }

  // 3. Supprimer tous les comptes sauf l'admin courant + leurs profils
  const usersToDelete = await db
    .select({ id: usersTable.id, pseudo: usersTable.pseudo })
    .from(usersTable)
    .where(ne(usersTable.id, adminId));

  for (const user of usersToDelete) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));
    await db.delete(profilesDataTable).where(eq(profilesDataTable.profileKey, user.pseudo));
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
  }

  // 4. Créer les nouveaux comptes depuis les profils importés
  // Le vrai pseudo est dans profData.name (ex: "🐉 Sah Muel"), pas dans la clé JSON
  const newUsers: { pseudo: string; emoji: string; password: string }[] = [];
  const usedPseudos = new Set<string>();

  for (const [key, profData] of Object.entries(profiles)) {
    if (key === "real" || key === "ia") continue;
    if (!profData || typeof profData !== "object") continue;

    const pd = profData as Record<string, unknown>;
    const { emoji, pseudo: rawPseudo } = parseProfileName(typeof pd["name"] === "string" ? pd["name"] : "");
    const lower = rawPseudo.toLowerCase();
    if (["real", "ia", "admin"].includes(lower)) continue;

    // Déduplication : si ce pseudo est déjà utilisé dans ce lot, ignorer
    if (usedPseudos.has(lower)) continue;
    usedPseudos.add(lower);

    const [newUser] = await db
      .insert(usersTable)
      .values({ pseudo: rawPseudo, passwordHash, passwordClear: GENERIC_PASSWORD, emoji, role: "user", pending: false })
      .returning({ id: usersTable.id });
    await db.insert(profilesDataTable).values({ profileKey: rawPseudo, userId: newUser.id, data: pd });
    newUsers.push({ pseudo: rawPseudo, emoji, password: GENERIC_PASSWORD });
  }

  res.json({ success: true, newUsers, deleted: usersToDelete.length });
});

// ── IMPORT PROFIL ──────────────────────────────────────────────────────────
// Pour chaque profil non-système du fichier :
//   - profil existant → écrase ses résultats
//   - profil inexistant → crée le compte (mdp 2026)
router.post("/admin/import/profile", requireAdmin, async (req, res): Promise<void> => {
  const { profiles } = req.body ?? {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    res.status(400).json({ error: "Données invalides : profiles manquant." });
    return;
  }

  const passwordHash = await bcrypt.hash(GENERIC_PASSWORD, 12);
  const results: { pseudo: string; action: "updated" | "created"; password?: string }[] = [];

  for (const [key, profData] of Object.entries(profiles)) {
    if (key === "real" || key === "ia") continue;
    if (!profData || typeof profData !== "object") continue;

    const pd = profData as Record<string, unknown>;
    // Le vrai pseudo est dans profData.name, pas dans la clé JSON
    const { emoji, pseudo: rawPseudo } = parseProfileName(typeof pd["name"] === "string" ? pd["name"] : key);
    const lower = rawPseudo.toLowerCase();
    if (["real", "ia", "admin"].includes(lower)) continue;

    // Chercher si un utilisateur avec ce pseudo existe déjà
    const existingUser = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.pseudo, rawPseudo)).limit(1);

    if (existingUser.length > 0) {
      // Écraser les résultats du profil existant
      const userId = existingUser[0].id;
      const ep = await db.select({ id: profilesDataTable.id }).from(profilesDataTable).where(eq(profilesDataTable.profileKey, rawPseudo)).limit(1);
      if (ep.length > 0) {
        await db.update(profilesDataTable).set({ data: pd, updatedAt: new Date() }).where(eq(profilesDataTable.profileKey, rawPseudo));
      } else {
        await db.insert(profilesDataTable).values({ profileKey: rawPseudo, userId, data: pd });
      }
      results.push({ pseudo: rawPseudo, action: "updated" });
    } else {
      // Créer le nouveau compte avec emoji extrait et mdp générique
      const [newUser] = await db
        .insert(usersTable)
        .values({ pseudo: rawPseudo, passwordHash, passwordClear: GENERIC_PASSWORD, emoji, role: "user", pending: false })
        .returning({ id: usersTable.id });
      await db.insert(profilesDataTable).values({ profileKey: rawPseudo, userId: newUser.id, data: pd });
      results.push({ pseudo: rawPseudo, action: "created", password: GENERIC_PASSWORD });
    }
  }

  res.json({ success: true, results });
});

// ── TRANSFERT DES DROITS ADMIN ─────────────────────────────────────────────
// L'admin courant cède ses droits à un joueur importé.
// L'admin devient "user", le joueur cible devient "admin".
router.put("/admin/users/:id/promote", requireAdmin, async (req: AuthRequest, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const adminId = req.userId!;
  if (id === adminId) {
    res.status(400).json({ error: "Vous êtes déjà administrateur." });
    return;
  }

  const targetRows = await db.select({ pseudo: usersTable.pseudo, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (targetRows.length === 0) { res.status(404).json({ error: "Utilisateur introuvable" }); return; }

  // Promouvoir le joueur cible en admin
  await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, id));

  // Supprimer le compte de l'admin courant (sessions + profil + compte)
  const adminRows = await db.select({ pseudo: usersTable.pseudo }).from(usersTable).where(eq(usersTable.id, adminId)).limit(1);
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, adminId));
  if (adminRows.length > 0) {
    await db.delete(profilesDataTable).where(eq(profilesDataTable.profileKey, adminRows[0].pseudo));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));

  res.json({ success: true, promotedPseudo: targetRows[0].pseudo });
});

export default router;
