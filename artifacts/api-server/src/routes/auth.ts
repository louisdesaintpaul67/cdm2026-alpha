import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db, usersTable, sessionsTable, settingsTable, profilesDataTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const RESERVED = ["real", "ia"];

const router = Router();

router.get("/auth/ping", (_req, res): void => {
  res.json({ ok: true });
});

router.get("/auth/registration-mode", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, "registrationMode"))
    .limit(1);
  const mode = rows.length > 0 ? rows[0].value : "ouvert";
  res.json({ mode });
});

router.post("/auth/register", async (req, res): Promise<void> => {
  const { pseudo, password, emoji } = req.body ?? {};

  if (!pseudo || typeof pseudo !== "string" || pseudo.trim().length < 2) {
    res.status(400).json({ success: false, message: "Pseudo invalide (2 caractères minimum)." });
    return;
  }
  const trimmedPseudo = pseudo.trim();
  if (RESERVED.includes(trimmedPseudo.toLowerCase()) || trimmedPseudo.toLowerCase() === "admin") {
    res.status(400).json({ success: false, message: "Ce pseudo est réservé." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 4) {
    res.status(400).json({ success: false, message: "Mot de passe invalide (4 caractères minimum)." });
    return;
  }

  const modeRows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, "registrationMode"))
    .limit(1);
  const mode = modeRows.length > 0 ? modeRows[0].value : "ouvert";

  if (mode === "ferme") {
    res.status(403).json({ success: false, message: "Les inscriptions sont fermées." });
    return;
  }

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.pseudo, trimmedPseudo))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ success: false, message: "Ce pseudo est déjà utilisé." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const chosenEmoji = typeof emoji === "string" && emoji.length > 0 ? emoji : "😎";
  const isPending = mode === "manuel";

  const [newUser] = await db
    .insert(usersTable)
    .values({ pseudo: trimmedPseudo, passwordHash, passwordClear: password, emoji: chosenEmoji, role: "user", pending: isPending })
    .returning({ id: usersTable.id });

  if (isPending) {
    res.json({ success: true, userId: newUser.id, pseudo: trimmedPseudo, emoji: chosenEmoji, pending: true });
    return;
  }

  const token = randomUUID();
  await db.insert(sessionsTable).values({ userId: newUser.id, token });

  res.json({ success: true, userId: newUser.id, pseudo: trimmedPseudo, emoji: chosenEmoji, token, role: "user" });
});

router.put("/auth/password", async (req, res): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) { res.status(401).json({ success: false, message: "Non authentifié" }); return; }
  const token = header.slice(7);

  const rows = await db.select({ userId: sessionsTable.userId }).from(sessionsTable).where(eq(sessionsTable.token, token)).limit(1);
  if (rows.length === 0) { res.status(401).json({ success: false, message: "Session invalide" }); return; }
  const userId = rows[0].userId;

  const { newPassword } = req.body ?? {};
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 4) {
    res.status(400).json({ success: false, message: "Mot de passe trop court (4 caractères minimum)." });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(usersTable).set({ passwordHash, passwordClear: newPassword }).where(eq(usersTable.id, userId));
  res.json({ success: true });
});

router.put("/auth/profile", async (req, res): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) { res.status(401).json({ success: false, message: "Non authentifié" }); return; }
  const token = header.slice(7);

  const rows = await db.select({ userId: sessionsTable.userId }).from(sessionsTable).where(eq(sessionsTable.token, token)).limit(1);
  if (rows.length === 0) { res.status(401).json({ success: false, message: "Session invalide" }); return; }
  const userId = rows[0].userId;

  const { emoji } = req.body ?? {};
  if (!emoji || typeof emoji !== "string") {
    res.status(400).json({ success: false, message: "Emoji requis." });
    return;
  }

  await db.update(usersTable).set({ emoji }).where(eq(usersTable.id, userId));
  res.json({ success: true });
});

// PUT /auth/pseudo — allows any authenticated user to change their own pseudo
router.put("/auth/pseudo", async (req, res): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) { res.status(401).json({ success: false, message: "Non authentifié" }); return; }
  const token = header.slice(7);

  const rows = await db
    .select({ userId: sessionsTable.userId, pseudo: usersTable.pseudo })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(eq(sessionsTable.token, token))
    .limit(1);
  if (rows.length === 0) { res.status(401).json({ success: false, message: "Session invalide" }); return; }
  const userId = rows[0].userId;
  const oldPseudo = rows[0].pseudo;

  const { pseudo } = req.body ?? {};
  if (!pseudo || typeof pseudo !== "string" || pseudo.trim().length < 2) {
    res.status(400).json({ success: false, message: "Pseudo invalide (2 caractères minimum)." });
    return;
  }
  const newPseudo = pseudo.trim();

  if (RESERVED.includes(newPseudo.toLowerCase()) || newPseudo.toLowerCase() === "admin") {
    res.status(400).json({ success: false, message: "Ce pseudo est réservé." });
    return;
  }

  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.pseudo, newPseudo)).limit(1);
  if (existing.length > 0 && newPseudo !== oldPseudo) {
    res.status(409).json({ success: false, message: "Ce pseudo est déjà utilisé." });
    return;
  }

  await db.update(usersTable).set({ pseudo: newPseudo }).where(eq(usersTable.id, userId));

  // Rename profile data key from old pseudo to new pseudo
  const profileRows = await db.select({ id: profilesDataTable.id }).from(profilesDataTable).where(eq(profilesDataTable.profileKey, oldPseudo)).limit(1);
  if (profileRows.length > 0) {
    await db.update(profilesDataTable).set({ profileKey: newPseudo }).where(eq(profilesDataTable.profileKey, oldPseudo));
  }

  res.json({ success: true, pseudo: newPseudo });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const { pseudo, password } = req.body ?? {};

  if (!pseudo || !password) {
    res.status(400).json({ success: false, message: "Pseudo et mot de passe requis." });
    return;
  }

  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.pseudo, pseudo.trim()))
    .limit(1);

  if (rows.length === 0) {
    res.status(401).json({ success: false, message: "Pseudo ou mot de passe incorrect." });
    return;
  }

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    res.status(401).json({ success: false, message: "Pseudo ou mot de passe incorrect." });
    return;
  }

  if (user.pending) {
    res.status(403).json({ success: false, message: "Votre compte est en attente de validation par un administrateur." });
    return;
  }

  const token = randomUUID();
  await db.insert(sessionsTable).values({ userId: user.id, token });

  res.json({ success: true, userId: user.id, pseudo: user.pseudo, emoji: user.emoji, token, role: user.role });
});

export default router;
