import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
  list({ offset = 0, limit = 50, sort = 'date_mod', order = 'ASC' } = {}) {
    const safeSort = sort === 'id' ? 'id' : 'date_mod';
    const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';
    const orderBy =
      safeSort === 'date_mod'
        ? `date_mod ${safeOrder}, id ${safeOrder}`
        : `id ${safeOrder}`;

    const rows = this.db
      .prepare(`SELECT * FROM tickets ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(limit, offset);

    return rows.map(rowToTicket);
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM tickets').get();
    return row.total;
  }

  close() {
    this.db.close();
  }
}
