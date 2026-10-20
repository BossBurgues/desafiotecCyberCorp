using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace SystemB.Api.Storage;

/// <summary>Operador da UI do B. Todos têm o mesmo acesso (o B não tem papéis): o login só identifica quem alterou.</summary>
public sealed record Operator(long Id, string Login, string Name);

/// <summary>
/// Contas e sessões do operador, no mesmo SQLite dos registros. Senha com PBKDF2-SHA256 e salt próprio; o token da
/// sessão só é guardado como SHA-256 (quem lê o banco não consegue entrar com ele).
/// </summary>
public sealed class SqliteOperatorStore
{
    private const int Iterations = 120_000;

    /// <summary>A sessão do operador vale por este tempo desde o login; depois, entrar de novo.</summary>
    public static readonly TimeSpan SessionTtl = TimeSpan.FromHours(12);

    // Hash de uma senha qualquer, calculado uma vez: o login inexistente paga o mesmo PBKDF2 que o existente
    private static readonly string DummyHash = HashPassword("conta-inexistente");
    private readonly string _connectionString;

    public SqliteOperatorStore(string dbPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = dbPath }.ToString();
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS operators(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              login TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operator_sessions(
              token_hash TEXT PRIMARY KEY,
              operator_id INTEGER NOT NULL REFERENCES operators(id),
              created_at TEXT NOT NULL);
            """;
        cmd.ExecuteNonQuery();
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    public static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iterations}${Convert.ToHexString(salt)}${Convert.ToHexString(hash)}";
    }

    public static bool VerifyPassword(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2" || !int.TryParse(parts[1], out var iterations)) return false;
        var expected = Convert.FromHexString(parts[3]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, Convert.FromHexString(parts[2]), iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static string TokenHash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    /// <summary>null = o login já existe.</summary>
    public Operator? Register(string login, string name, string password, string now)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO operators(login, name, password_hash, created_at) VALUES($l, $n, $p, $t) RETURNING id";
        cmd.Parameters.AddWithValue("$l", login);
        cmd.Parameters.AddWithValue("$n", name);
        cmd.Parameters.AddWithValue("$p", HashPassword(password));
        cmd.Parameters.AddWithValue("$t", now);
        return cmd.ExecuteScalar() is long id ? new Operator(id, login, name) : null;
    }

    /// <summary>Confere login e senha e abre uma sessão: devolve o token (só aparece aqui) ou null.</summary>
    public (string Token, Operator Operator)? Login(string login, string password, string now)
    {
        using var conn = Open();
        using var find = conn.CreateCommand();
        find.CommandText = "SELECT id, login, name, password_hash FROM operators WHERE login = $l";
        find.Parameters.AddWithValue("$l", login);
        Operator? op = null;
        string? stored = null;
        using (var r = find.ExecuteReader())
        {
            if (r.Read())
            {
                op = new Operator(r.GetInt64(0), r.GetString(1), r.GetString(2));
                stored = r.GetString(3);
            }
        }
        // Login inexistente também passa pelo PBKDF2: o tempo de resposta não revela quem tem conta
        var ok = VerifyPassword(password, stored ?? DummyHash);
        if (op is null || !ok) return null;

        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        using var insert = conn.CreateCommand();
        insert.CommandText = "INSERT INTO operator_sessions(token_hash, operator_id, created_at) VALUES($h, $o, $t)";
        insert.Parameters.AddWithValue("$h", TokenHash(token));
        insert.Parameters.AddWithValue("$o", op.Id);
        insert.Parameters.AddWithValue("$t", now);
        insert.ExecuteNonQuery();
        return (token, op);
    }

    /// <summary>Operador de uma sessão aberta depois de <paramref name="notBefore"/> (mesmo formato ISO do created_at).</summary>
    public Operator? FindBySession(string? token, string notBefore)
    {
        if (string.IsNullOrEmpty(token)) return null;
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT o.id, o.login, o.name FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
            WHERE s.token_hash = $h AND s.created_at > $nb
            """;
        cmd.Parameters.AddWithValue("$h", TokenHash(token));
        cmd.Parameters.AddWithValue("$nb", notBefore);
        using var r = cmd.ExecuteReader();
        return r.Read() ? new Operator(r.GetInt64(0), r.GetString(1), r.GetString(2)) : null;
    }

    public void Logout(string token)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM operator_sessions WHERE token_hash = $h";
        cmd.Parameters.AddWithValue("$h", TokenHash(token));
        cmd.ExecuteNonQuery();
    }
}
