import { Router } from "express";
import { db, usersTable, profilesDataTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth";

const router = Router();

/**
 * GET /data
 * Returns all profiles the caller can see.
 * - Admin: all profiles + list of admin pseudos
 * - User: all profiles (for leaderboard) + list of admin pseudos
 */
router.get("/data", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const isAdmin = req.userRole === "admin";

  // Fetch all profile rows
  const rows = await db.select().from(profilesDataTable);

  // Build profiles map (key → data) — all users see all profiles for leaderboard
  const profiles: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    profiles[row.profileKey] = row.data as Record<string, unknown>;
  }

  // Admin pseudos — returned to all users so leaderboard can distinguish
  const admins = await db
    .select({ pseudo: usersTable.pseudo })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  const adminPseudos = admins.map((a) => a.pseudo);

  // Public settings exposed to all authenticated users
  const settingRows = await db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, "allowRandomGeneration"));
  const allowRandomGeneration = settingRows.length === 0 || settingRows[0].value !== "false";

  res.json({ profiles, adminPseudos, settings: { allowRandomGeneration } });
});

/**
 * PUT /data/:key
 * Saves (upserts) a profile's JSON data.
 * - Admin can save any key (including "real" and "ia")
 * - Users can only save their own pseudo key
 */
router.put("/data/:key", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const rawKey = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const key = decodeURIComponent(rawKey);
  const isAdmin = req.userRole === "admin";
  const ownPseudo = req.userPseudo!;

  if (!isAdmin && key !== ownPseudo) {
    res.status(403).json({ error: "Vous ne pouvez modifier que votre propre profil." });
    return;
  }

  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    res.status(400).json({ error: "Corps de requête invalide." });
    return;
  }

  const LOCK_FIELDS = ["poulesLocked", "knockoutLocked", "buteurLocked"] as const;

  const existing = await db
    .select({ id: profilesDataTable.id, data: profilesDataTable.data })
    .from(profilesDataTable)
    .where(eq(profilesDataTable.profileKey, key))
    .limit(1);

  if (existing.length > 0) {
    const existingData = (existing[0].data as Record<string, unknown>) ?? {};
    const mergedData = { ...(data as Record<string, unknown>) };

    // DB is authoritative for lock flags — client can never set or clear them
    for (const field of LOCK_FIELDS) {
      mergedData[field] = !!existingData[field];
    }

    // When a section is locked, also preserve its data from DB so clients cannot overwrite it
    if (existingData["poulesLocked"]) {
      mergedData["groupScores"] = existingData["groupScores"];
    }
    if (existingData["knockoutLocked"]) {
      mergedData["koScores"] = existingData["koScores"];
    }
    if (existingData["buteurLocked"]) {
      mergedData["topScorer"] = existingData["topScorer"];
    }

    await db
      .update(profilesDataTable)
      .set({ data: mergedData, updatedAt: new Date() })
      .where(eq(profilesDataTable.profileKey, key));
  } else {
    // Find userId for this key (if it's a user's pseudo)
    const userRows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.pseudo, key))
      .limit(1);
    const userId = userRows.length > 0 ? userRows[0].id : null;
    await db.insert(profilesDataTable).values({ profileKey: key, userId, data });
  }

  res.json({ success: true });
});

/**
 * POST /predictions/migrate
 * No-op migration endpoint for client compatibility.
 */
router.post("/predictions/migrate", requireAuth, async (_req, res): Promise<void> => {
  res.json({ success: true, migrated: 0 });
});

export default router;
