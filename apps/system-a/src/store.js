import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  PROFILES,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './auth.js';

export const DEFAULT_DB_PATH = './data/system-a.db';

function rowToTicket(row) {
  if (!row) {
    return null;
  }
  const ticket = {
    id: row.id,
    name: row.name,
    content: row.content,
    status: row.status,
    priority: row.priority,
    itilcategories_id: row.itilcategories_id,
    locations_id: row.locations_id,
    users_id_recipient: row.users_id_recipient,
    users_id_assign: row.users_id_assign,
    date: row.date,
    date_mod: row.date_mod,
    solvedate: row.solvedate,
    closedate: row.closedate,
  };
  if (row.attachments_json !== null && row.attachments_json !== undefined) {
    ticket.attachments = JSON.parse(row.attachments_json);
  }
  return ticket;
}

export class TicketStore {
  constructor(dbPath = process.env.A_DB_PATH || DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        status INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        itilcategories_id INTEGER,
        locations_id INTEGER,
        users_id_recipient INTEGER,
        users_id_assign INTEGER,
        date TEXT NOT NULL,
        date_mod TEXT NOT NULL,
        solvedate TEXT,
        closedate TEXT,
        attachments_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_date_mod_id ON tickets (date_mod, id);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        login TEXT UNIQUE NOT NULL,
        profile TEXT NOT NULL CHECK (profile IN ('tecnico', 'estagiario', 'sync-bot')),
        password_hash TEXT,
        api_token_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_denials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        status INTEGER NOT NULL,
        error_code TEXT NOT NULL,
        user_id INTEGER,
        login TEXT,
        profile TEXT,
        action TEXT,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        ticket_id INTEGER,
        origin_ip TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS access_denials_no_update BEFORE UPDATE ON access_denials
      BEGIN SELECT RAISE(ABORT, 'access_denials é append-only'); END;

      CREATE TRIGGER IF NOT EXISTS access_denials_no_delete BEFORE DELETE ON access_denials
      BEGIN SELECT RAISE(ABORT, 'access_denials é append-only'); END;
    `);
  }

  insert(ticket) {
    const stmt = this.db.prepare(`
      INSERT INTO tickets (
        name,
        content,
        status,
        priority,
        itilcategories_id,
        locations_id,
        users_id_recipient,
        users_id_assign,
        date,
        date_mod,
        solvedate,
        closedate,
        attachments_json
      ) VALUES (
        @name,
        @content,
        @status,
        @priority,
        @itilcategories_id,
        @locations_id,
        @users_id_recipient,
        @users_id_assign,
        @date,
        @date_mod,
        @solvedate,
        @closedate,
        @attachments_json
      )
    `);
    const info = stmt.run({
      name: ticket.name,
      content: ticket.content,
      status: ticket.status,
      priority: ticket.priority,
      itilcategories_id: ticket.itilcategories_id ?? null,
      locations_id: ticket.locations_id ?? null,
      users_id_recipient: ticket.users_id_recipient ?? null,
      users_id_assign: ticket.users_id_assign ?? null,
      date: ticket.date,
      date_mod: ticket.date_mod,
      solvedate: ticket.solvedate ?? null,
      closedate: ticket.closedate ?? null,
      attachments_json:
        ticket.attachments !== undefined ? JSON.stringify(ticket.attachments) : null,
    });
    return this.getById(Number(info.lastInsertRowid));
  }

  getById(id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    return rowToTicket(row);
  }

  update(id, fields) {
    const current = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!current) {
      return null;
    }
    const next = {
      id,
      name: fields.name !== undefined ? fields.name : current.name,
      content: fields.content !== undefined ? fields.content : current.content,
      status: fields.status !== undefined ? fields.status : current.status,
      priority: fields.priority !== undefined ? fields.priority : current.priority,
      itilcategories_id:
        fields.itilcategories_id !== undefined
          ? fields.itilcategories_id
          : current.itilcategories_id,
      locations_id:
        fields.locations_id !== undefined ? fields.locations_id : current.locations_id,
      users_id_recipient:
        fields.users_id_recipient !== undefined
          ? fields.users_id_recipient
          : current.users_id_recipient,
      users_id_assign:
        fields.users_id_assign !== undefined ? fields.users_id_assign : current.users_id_assign,
      date_mod: fields.date_mod !== undefined ? fields.date_mod : current.date_mod,
      solvedate: fields.solvedate !== undefined ? fields.solvedate : current.solvedate,
      closedate: fields.closedate !== undefined ? fields.closedate : current.closedate,
      attachments_json:
        fields.attachments !== undefined
          ? JSON.stringify(fields.attachments)
          : current.attachments_json,
    };

    this.db
      .prepare(`
        UPDATE tickets
        SET name = @name,
            content = @content,
            status = @status,
            priority = @priority,
            itilcategories_id = @itilcategories_id,
            locations_id = @locations_id,
            users_id_recipient = @users_id_recipient,
            users_id_assign = @users_id_assign,
            date_mod = @date_mod,
            solvedate = @solvedate,
            closedate = @closedate,
            attachments_json = @attachments_json
        WHERE id = @id
      `)
      .run(next);

    return this.getById(id);
  }

  // Desempate por id garante ordem estável quando dois chamados empatam no mesmo segundo de date_mod.
  // Ambos date_mod e date_mod_gte estão em YYYY-MM-DD HH:MM:SS no fuso do A, permitindo comparação lexical direta.
  list({ offset = 0, limit = 50, sort = 'date_mod', order = 'ASC', dateModGte = null } = {}) {
    const safeSort = sort === 'id' ? 'id' : 'date_mod';
    const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';
    const orderBy =
      safeSort === 'date_mod'
        ? `date_mod ${safeOrder}, id ${safeOrder}`
        : `id ${safeOrder}`;

    if (dateModGte !== null && dateModGte !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT * FROM tickets WHERE date_mod >= ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        )
        .all(dateModGte, limit, offset);
      return rows.map(rowToTicket);
    }

    const rows = this.db
      .prepare(`SELECT * FROM tickets ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(limit, offset);

    return rows.map(rowToTicket);
  }

  count({ dateModGte = null } = {}) {
    if (dateModGte !== null && dateModGte !== undefined) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS total FROM tickets WHERE date_mod >= ?')
        .get(dateModGte);
      return row.total;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM tickets').get();
    return row.total;
  }

  seedUsers({ tecnicoPassword, estagiarioPassword, syncBotToken }) {
    const insertIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO users (id, login, profile, password_hash, api_token_hash)
      VALUES (@id, @login, @profile, @password_hash, @api_token_hash)
    `);
    const selectById = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const updatePassword = this.db.prepare(
      'UPDATE users SET password_hash = ?, api_token_hash = NULL WHERE id = ?',
    );
    const updateToken = this.db.prepare(
      'UPDATE users SET api_token_hash = ?, password_hash = NULL WHERE id = ?',
    );

    const runSeed = this.db.transaction(() => {
      // IDs fixos 1 (tecnico), 2 (estagiario) e 3 (sync-bot) batem com o exemplo do contrato e estabilizam o filtro anti-eco (ADR-009).
      const humans = [
        { id: 1, login: 'tecnico', profile: PROFILES.TECNICO, password: tecnicoPassword },
        { id: 2, login: 'estagiario', profile: PROFILES.ESTAGIARIO, password: estagiarioPassword },
      ];

      for (const h of humans) {
        const existing = selectById.get(h.id);
        if (!existing) {
          insertIgnore.run({
            id: h.id,
            login: h.login,
            profile: h.profile,
            password_hash: hashPassword(h.password),
            api_token_hash: null,
          });
        } else if (!verifyPassword(h.password, existing.password_hash)) {
          updatePassword.run(hashPassword(h.password), h.id);
        }
      }

      const botTokenHash = hashToken(syncBotToken);
      const existingBot = selectById.get(3);
      if (!existingBot) {
        insertIgnore.run({
          id: 3,
          login: 'sync-bot',
          profile: PROFILES.SYNC_BOT,
          password_hash: null,
          api_token_hash: botTokenHash,
        });
      } else if (existingBot.api_token_hash !== botTokenHash) {
        updateToken.run(botTokenHash, 3);
      }
    });

    runSeed();
  }

  findUserByLogin(login) {
    return this.db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null;
  }

  findUserByApiTokenHash(apiTokenHash) {
    return (
      this.db.prepare('SELECT * FROM users WHERE api_token_hash = ?').get(apiTokenHash) || null
    );
  }

  createSession(userId, now = Date.now) {
    const token = generateSessionToken();
    const instant = typeof now === 'function' ? now() : now;
    const createdAt = new Date(instant).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(token, userId, createdAt);
    return token;
  }

  getSessionUser(token) {
    if (typeof token !== 'string' || token === '') {
      return null;
    }
    const row = this.db
      .prepare(`
        SELECT u.id, u.login, u.profile
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
      `)
      .get(token);
    return row || null;
  }

  deleteSession(token) {
    if (typeof token !== 'string' || token === '') {
      return false;
    }
    const info = this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return info.changes > 0;
  }

  recordDenial(denial) {
    const stmt = this.db.prepare(`
      INSERT INTO access_denials (
        occurred_at,
        status,
        error_code,
        user_id,
        login,
        profile,
        action,
        method,
        url,
        ticket_id,
        origin_ip
      ) VALUES (
        @occurred_at,
        @status,
        @error_code,
        @user_id,
        @login,
        @profile,
        @action,
        @method,
        @url,
        @ticket_id,
        @origin_ip
      )
    `);
    const info = stmt.run({
      occurred_at: denial.occurred_at,
      status: denial.status,
      error_code: denial.error_code,
      user_id: denial.user_id ?? null,
      login: denial.login ?? null,
      profile: denial.profile ?? null,
      action: denial.action ?? null,
      method: denial.method,
      url: denial.url,
      ticket_id: denial.ticket_id ?? null,
      origin_ip: denial.origin_ip,
    });
    return this.db
      .prepare('SELECT * FROM access_denials WHERE id = ?')
      .get(Number(info.lastInsertRowid));
  }

  listDenials() {
    return this.db.prepare('SELECT * FROM access_denials ORDER BY id ASC').all();
  }

  close() {
    this.db.close();
  }
}
