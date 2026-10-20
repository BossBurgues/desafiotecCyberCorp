using System.Collections.Concurrent;

namespace SystemB.Api.Storage;

/// <summary>
/// Limite simples de tentativas na autenticação do operador, em memória (uma instância do B): conta eventos por chave
/// numa janela deslizante. Login errado conta por IP + usuário; cadastro conta por IP.
/// </summary>
public sealed class AuthThrottle(TimeProvider clock)
{
    public const int MaxFailedLogins = 10;
    public const int MaxRegistrations = 20;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(15);

    private readonly ConcurrentDictionary<string, List<DateTimeOffset>> _events = new();

    private List<DateTimeOffset> Recent(string key)
    {
        var cutoff = clock.GetUtcNow() - Window;
        var list = _events.GetOrAdd(key, _ => []);
        lock (list) list.RemoveAll(t => t <= cutoff);
        return list;
    }

    public bool Exceeded(string key, int max)
    {
        var list = Recent(key);
        lock (list) return list.Count >= max;
    }

    public void Hit(string key)
    {
        var list = Recent(key);
        lock (list) list.Add(clock.GetUtcNow());
    }

    public void Clear(string key) => _events.TryRemove(key, out _);
}
