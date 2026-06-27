import { Request, Response, NextFunction } from "express";
import { db, sessionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AuthRequest extends Request {
  userId?: number;
  userRole?: string;
  userPseudo?: string;
}

async function resolveSession(req: AuthRequest): Promise<boolean> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);

  const rows = await db
    .select({
      userId: sessionsTable.userId,
      role: usersTable.role,
      pseudo: usersTable.pseudo,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(eq(sessionsTable.token, token))
    .limit(1);

  if (rows.length === 0) return false;

  req.userId = rows[0].userId;
  req.userRole = rows[0].role;
  req.userPseudo = rows[0].pseudo;
  return true;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ok = await resolveSession(req);
  if (!ok) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }
  next();
}

export async function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ok = await resolveSession(req);
  if (!ok) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }
  if (req.userRole !== "admin") {
    res.status(403).json({ error: "Accès réservé aux administrateurs." });
    return;
  }
  next();
}
