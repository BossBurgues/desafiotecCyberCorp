using System.Text.Json;
using Microsoft.Data.Sqlite;
using SystemB.Api.Models;

namespace SystemB.Api.Storage;

/// <summary>Uma conexão por operação; o corpo do registro é o JSON do RecordInput.</summary>
public sealed class SqliteRecordStore : IRecordStore
{
    private readonly string _connectionString;

    public SqliteRecordStore(string dbPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = dbPath }.ToString();

        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS records(
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT UNIQUE,
              body TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL)
            """;
        cmd.ExecuteNonQuery();

        // Autor da última alteração (capacidade "updatedBy"), em coluna própria: o corpo é só o que o cliente mandou.
        // Bancos criados antes da coluna ganham ela aqui (SQLite não tem ADD COLUMN IF NOT EXISTS)
        cmd.CommandText = "SELECT COUNT(*) FROM pragma_table_info('records') WHERE name = 'updated_by'";
        if ((long)cmd.ExecuteScalar()! == 0)
        {
            cmd.CommandText = "ALTER TABLE records ADD COLUMN updated_by TEXT";
            cmd.ExecuteNonQuery();
        }
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    private static string Serialize(RecordInput i) => JsonSerializer.Serialize(i, JsonDefaults.Options);

    private static Models.Record Read(SqliteDataReader r) => Models.Record.From(
        r.GetString(0),
        JsonSerializer.Deserialize<RecordInput>(r.GetString(1), JsonDefaults.Options)!,
        r.GetString(2),
        r.GetString(3),
        r.IsDBNull(4) ? null : r.GetString(4));

    private const string Columns = "id, body, created_at, updated_at, updated_by";

    public Models.Record Create(RecordInput input, string now, string? updatedBy = null)
    {
        using var conn = Open();
        using var tx = conn.BeginTransaction();
        using var insert = conn.CreateCommand();
        insert.Transaction = tx;
        insert.CommandText = "INSERT INTO records(body, created_at, updated_at, updated_by) VALUES($b, $n, $n, $u)";
        insert.Parameters.AddWithValue("$b", Serialize(input));
        insert.Parameters.AddWithValue("$n", now);
        insert.Parameters.AddWithValue("$u", (object?)updatedBy ?? DBNull.Value);
        insert.ExecuteNonQuery();

        using var idCmd = conn.CreateCommand();
        idCmd.Transaction = tx;
        idCmd.CommandText = "SELECT last_insert_rowid()";
        var id = "B-" + (long)idCmd.ExecuteScalar()!;

        using var upd = conn.CreateCommand();
        upd.Transaction = tx;
        upd.CommandText = "UPDATE records SET id = $id WHERE seq = last_insert_rowid()";
        upd.Parameters.AddWithValue("$id", id);
        upd.ExecuteNonQuery();

        tx.Commit();
        return Models.Record.From(id, input, now, now, updatedBy);
    }

    public Models.Record? Get(string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM records WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? Read(r) : null;
    }

    public Models.Record? Replace(string id, RecordInput input, string now, string? updatedBy = null)
    {
        using var conn = Open();
        using var tx = conn.BeginTransaction();
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "UPDATE records SET body = $b, updated_at = $n, updated_by = $u WHERE id = $id RETURNING created_at";
        cmd.Parameters.AddWithValue("$b", Serialize(input));
        cmd.Parameters.AddWithValue("$n", now);
        cmd.Parameters.AddWithValue("$u", (object?)updatedBy ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$id", id);
        string? createdAt;
        using (var r = cmd.ExecuteReader())
            createdAt = r.Read() ? r.GetString(0) : null;
        if (createdAt is null) return null;
        tx.Commit();
        return Models.Record.From(id, input, createdAt, now, updatedBy);
    }

    public IReadOnlyList<Models.Record> List(int offset, int limit, string? createdAtOrBefore = null)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM records WHERE ($c IS NULL OR created_at <= $c) ORDER BY seq ASC LIMIT $l OFFSET $o";
        cmd.Parameters.AddWithValue("$c", (object?)createdAtOrBefore ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$l", limit);
        cmd.Parameters.AddWithValue("$o", offset);
        using var r = cmd.ExecuteReader();
        var items = new List<Models.Record>();
        while (r.Read()) items.Add(Read(r));
        return items;
    }

    public int Count(string? createdAtOrBefore = null)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        // created_at é ISO 8601 em UTC com milissegundos fixos: a comparação de texto respeita a ordem do tempo
        cmd.CommandText = "SELECT COUNT(*) FROM records WHERE ($c IS NULL OR created_at <= $c)";
        cmd.Parameters.AddWithValue("$c", (object?)createdAtOrBefore ?? DBNull.Value);
        return (int)(long)cmd.ExecuteScalar()!;
    }

    public bool Delete(string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM records WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    public int Wipe()
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM records";
        return cmd.ExecuteNonQuery();
    }
}
