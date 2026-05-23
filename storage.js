import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export function createDiaryStorage({ databaseUrl = "", databasePath }) {
  if (databaseUrl) {
    return createPostgresStorage(databaseUrl);
  }

  return createJsonStorage(databasePath);
}

function createJsonStorage(databasePath) {
  const database = loadDatabase(databasePath);

  return {
    kind: `json:${databasePath}`,

    async initialize() {},

    async findUserById(id) {
      return database.users.find((user) => user.id === id) || null;
    },

    async findUserByEmail(email) {
      return database.users.find((user) => user.email === email) || null;
    },

    async findUserByGoogleIdOrEmail(googleId, email) {
      return (
        database.users.find((user) => user.googleId === googleId) ||
        database.users.find((user) => user.email === email) ||
        null
      );
    },

    async createUser(user) {
      database.users.push(user);
      writeDatabase(databasePath, database);
      return user;
    },

    async updateUser(user) {
      const index = database.users.findIndex((candidate) => candidate.id === user.id);
      if (index === -1) return null;

      database.users[index] = user;
      writeDatabase(databasePath, database);
      return user;
    },

    async createSession(session) {
      pruneExpiredSessions(database);
      database.sessions.push(session);
      writeDatabase(databasePath, database);
      return session;
    },

    async findSessionById(id) {
      return database.sessions.find((session) => session.id === id) || null;
    },

    async deleteSession(id) {
      const before = database.sessions.length;
      database.sessions = database.sessions.filter((session) => session.id !== id);
      if (database.sessions.length !== before) writeDatabase(databasePath, database);
    },

    async pruneExpiredSessions() {
      if (pruneExpiredSessions(database)) writeDatabase(databasePath, database);
    },

    async listEntries(userId) {
      return database.entries
        .filter((entry) => entry.userId === userId)
        .sort((a, b) => b.date.localeCompare(a.date));
    },

    async upsertEntry(entry) {
      let savedEntry = database.entries.find(
        (candidate) => candidate.userId === entry.userId && candidate.date === entry.date
      );

      if (savedEntry) {
        savedEntry.summary = entry.summary;
        savedEntry.conversation = entry.conversation;
        savedEntry.updatedAt = entry.updatedAt;
      } else {
        savedEntry = entry;
        database.entries.push(savedEntry);
      }

      writeDatabase(databasePath, database);
      return savedEntry;
    },

    async findPendingRegistration(email) {
      return (
        database.emailCodes.find(
          (record) => record.purpose === "registration" && record.email === email
        ) || null
      );
    },

    async savePendingRegistration(record) {
      database.emailCodes = database.emailCodes.filter(
        (candidate) => !(candidate.purpose === "registration" && candidate.email === record.email)
      );
      database.emailCodes.push(record);
      writeDatabase(databasePath, database);
      return record;
    },

    async updateEmailCode(record) {
      const index = database.emailCodes.findIndex((candidate) => candidate.id === record.id);
      if (index === -1) return null;

      database.emailCodes[index] = record;
      writeDatabase(databasePath, database);
      return record;
    },

    async deleteEmailCode(id) {
      const before = database.emailCodes.length;
      database.emailCodes = database.emailCodes.filter((record) => record.id !== id);
      if (database.emailCodes.length !== before) writeDatabase(databasePath, database);
    },

    async pruneExpiredEmailCodes() {
      const now = Date.now();
      const before = database.emailCodes.length;
      database.emailCodes = database.emailCodes.filter((record) => Date.parse(record.expiresAt) > now);
      const changed = database.emailCodes.length !== before;
      if (changed) writeDatabase(databasePath, database);
      return changed;
    },
  };
}

function createPostgresStorage(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number.parseInt(process.env.DATABASE_POOL_SIZE || "5", 10) || 5,
    ssl: postgresSslConfig(databaseUrl),
  });

  return {
    kind: "postgres",

    async initialize() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id text PRIMARY KEY,
          name text NOT NULL,
          email text NOT NULL UNIQUE,
          password_hash text,
          google_id text UNIQUE,
          auth_provider text,
          avatar_url text,
          email_verified_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS entries (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date text NOT NULL,
          summary text NOT NULL,
          conversation jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          UNIQUE (user_id, date)
        );

        CREATE INDEX IF NOT EXISTS entries_user_date_idx ON entries(user_id, date DESC);

        CREATE TABLE IF NOT EXISTS email_codes (
          id text PRIMARY KEY,
          purpose text NOT NULL,
          name text,
          email text NOT NULL,
          password_hash text,
          code_hash text NOT NULL,
          salt text NOT NULL,
          attempts integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL
        );

        CREATE INDEX IF NOT EXISTS email_codes_email_purpose_idx ON email_codes(email, purpose);
        CREATE INDEX IF NOT EXISTS email_codes_expires_at_idx ON email_codes(expires_at);
      `);
    },

    async findUserById(id) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
      return mapUser(result.rows[0]);
    },

    async findUserByEmail(email) {
      const result = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
      return mapUser(result.rows[0]);
    },

    async findUserByGoogleIdOrEmail(googleId, email) {
      const result = await pool.query(
        `SELECT *
           FROM users
          WHERE google_id = $1 OR email = $2
          ORDER BY CASE WHEN google_id = $1 THEN 0 ELSE 1 END
          LIMIT 1`,
        [googleId, email]
      );
      return mapUser(result.rows[0]);
    },

    async createUser(user) {
      const result = await pool.query(
        `INSERT INTO users (
           id, name, email, password_hash, google_id, auth_provider, avatar_url,
           email_verified_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          user.id,
          user.name,
          user.email,
          nullable(user.passwordHash),
          nullable(user.googleId),
          nullable(user.authProvider),
          nullable(user.avatarUrl),
          nullable(user.emailVerifiedAt),
          user.createdAt,
          user.updatedAt,
        ]
      );
      return mapUser(result.rows[0]);
    },

    async updateUser(user) {
      const result = await pool.query(
        `UPDATE users
            SET name = $2,
                email = $3,
                password_hash = $4,
                google_id = $5,
                auth_provider = $6,
                avatar_url = $7,
                email_verified_at = $8,
                updated_at = $9
          WHERE id = $1
          RETURNING *`,
        [
          user.id,
          user.name,
          user.email,
          nullable(user.passwordHash),
          nullable(user.googleId),
          nullable(user.authProvider),
          nullable(user.avatarUrl),
          nullable(user.emailVerifiedAt),
          user.updatedAt,
        ]
      );
      return mapUser(result.rows[0]);
    },

    async createSession(session) {
      await this.pruneExpiredSessions();
      await pool.query(
        `INSERT INTO sessions (id, user_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [session.id, session.userId, session.createdAt, session.expiresAt]
      );
      return session;
    },

    async findSessionById(id) {
      const result = await pool.query("SELECT * FROM sessions WHERE id = $1 LIMIT 1", [id]);
      return mapSession(result.rows[0]);
    },

    async deleteSession(id) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
    },

    async pruneExpiredSessions() {
      await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
    },

    async listEntries(userId) {
      const result = await pool.query(
        `SELECT *
           FROM entries
          WHERE user_id = $1
          ORDER BY date DESC`,
        [userId]
      );
      return result.rows.map(mapEntry);
    },

    async upsertEntry(entry) {
      const result = await pool.query(
        `INSERT INTO entries (
           id, user_id, date, summary, conversation, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (user_id, date)
         DO UPDATE SET
           summary = EXCLUDED.summary,
           conversation = EXCLUDED.conversation,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          entry.id,
          entry.userId,
          entry.date,
          entry.summary,
          JSON.stringify(entry.conversation),
          entry.createdAt,
          entry.updatedAt,
        ]
      );
      return mapEntry(result.rows[0]);
    },

    async findPendingRegistration(email) {
      const result = await pool.query(
        `SELECT *
           FROM email_codes
          WHERE purpose = 'registration' AND email = $1
          ORDER BY updated_at DESC
          LIMIT 1`,
        [email]
      );
      return mapEmailCode(result.rows[0]);
    },

    async savePendingRegistration(record) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM email_codes WHERE purpose = 'registration' AND email = $1",
          [record.email]
        );
        const result = await client.query(
          `INSERT INTO email_codes (
             id, purpose, name, email, password_hash, code_hash, salt,
             attempts, created_at, updated_at, expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            record.id,
            record.purpose,
            nullable(record.name),
            record.email,
            nullable(record.passwordHash),
            record.codeHash,
            record.salt,
            record.attempts,
            record.createdAt,
            record.updatedAt,
            record.expiresAt,
          ]
        );
        await client.query("COMMIT");
        return mapEmailCode(result.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async updateEmailCode(record) {
      const result = await pool.query(
        `UPDATE email_codes
            SET attempts = $2,
                updated_at = $3
          WHERE id = $1
          RETURNING *`,
        [record.id, record.attempts, record.updatedAt]
      );
      return mapEmailCode(result.rows[0]);
    },

    async deleteEmailCode(id) {
      await pool.query("DELETE FROM email_codes WHERE id = $1", [id]);
    },

    async pruneExpiredEmailCodes() {
      const result = await pool.query("DELETE FROM email_codes WHERE expires_at <= now()");
      return result.rowCount > 0;
    },
  };
}

function loadDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) {
    return { users: [], sessions: [], entries: [], emailCodes: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    emailCodes: Array.isArray(parsed.emailCodes) ? parsed.emailCodes : [],
  };
}

function writeDatabase(databasePath, database) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const tempPath = `${databasePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(database, null, 2)}\n`);
  fs.renameSync(tempPath, databasePath);
}

function pruneExpiredSessions(database) {
  const now = Date.now();
  const before = database.sessions.length;
  database.sessions = database.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  return database.sessions.length !== before;
}

function postgresSslConfig(databaseUrl) {
  if (process.env.DATABASE_SSL === "false" || process.env.PGSSLMODE === "disable") {
    return false;
  }

  const hostname = new URL(databaseUrl).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return false;
  }

  return { rejectUnauthorized: false };
}

function nullable(value) {
  return value || null;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash || "",
    googleId: row.google_id || "",
    authProvider: row.auth_provider || "",
    avatarUrl: row.avatar_url || "",
    emailVerifiedAt: toIso(row.email_verified_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

function mapEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    summary: row.summary,
    conversation: Array.isArray(row.conversation) ? row.conversation : [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEmailCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    purpose: row.purpose,
    name: row.name || "",
    email: row.email,
    passwordHash: row.password_hash || "",
    codeHash: row.code_hash,
    salt: row.salt,
    attempts: Number(row.attempts || 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
  };
}

function toIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
