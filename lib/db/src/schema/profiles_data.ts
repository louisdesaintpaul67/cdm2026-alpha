import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const profilesDataTable = pgTable("profiles_data", {
  id: serial("id").primaryKey(),
  profileKey: text("profile_key").notNull().unique(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  data: jsonb("data").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
