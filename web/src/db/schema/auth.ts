import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ROLES } from "../../lib/permissions"; // relative: drizzle-kit does not read tsconfig paths

// Better Auth tables (D04). Property names are Better Auth's field names; lib/auth.ts maps its models to these
// table names ("user" is reserved in SQL, and T06 owns "accounts"). Ids are Better Auth-style text ids.
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Better Auth requires a unique email. Staff sign in with username only, so this holds a hidden placeholder.
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
    username: text("username").unique(), // lowercase; sign-in lowercases what was typed
    displayUsername: text("display_username"),
    role: text("role", { enum: ROLES }).notNull(),
    canViewCost: boolean("can_view_cost").notNull(),
    active: boolean("active").notNull().default(true),
    // Set by lib/users.ts on a password reset, so the audited users row shows when (the hash lives in auth_accounts).
    passwordChangedAt: ts("password_changed_at"),
  },
  (t) => [check("users_role_check", sql`${t.role} in ('owner', 'accountant', 'sales', 'production')`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/** Better Auth's "account" model: the password hash lives here (providerId "credential", accountId = user id). */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("auth_accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// Better Auth's request rate limits (D42, T44a): kept in the database so every server instance shares the counts.
// key = client IP + path; last_request = epoch milliseconds. Not audited (D42), and Better Auth prunes old rows.
export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
