using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

public sealed class SystemBFactory : WebApplicationFactory<Program>
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"systemb-api-{Guid.NewGuid():N}.db");

    public const string AdminToken = "test-admin-token";

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero));

    /// <summary>Configurações extras (ex.: B_CHAOS_*), aplicadas como se viessem do ambiente.</summary>
    public Dictionary<string, string?> Settings { get; init; } = [];

    /// <summary>Cliente que já entrou na UI do operador (as rotas /operator/records exigem sessão), com o nome dado.</summary>
    public HttpClient CreateOperatorClient(string name = "Maria", WebApplicationFactoryClientOptions? options = null)
    {
        var c = options is null ? CreateClient() : CreateClient(options);
        var login = $"op-{Guid.NewGuid():N}"[..12];
        var account = new JsonObject { ["login"] = login, ["name"] = name, ["password"] = "senha-de-teste" }.ToJsonString();
        c.PostAsync("/operator/auth/register", Api.Json(account)).GetAwaiter().GetResult().EnsureSuccessStatusCode();
        var credentials = new JsonObject { ["login"] = login, ["password"] = "senha-de-teste" }.ToJsonString();
        var res = c.PostAsync("/operator/auth/login", Api.Json(credentials)).GetAwaiter().GetResult();
        res.EnsureSuccessStatusCode();
        var token = (string)JsonNode.Parse(res.Content.ReadAsStringAsync().GetAwaiter().GetResult())!["token"]!;
        c.DefaultRequestHeaders.Add("X-Session-Token", token);
        return c;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("B_DB_PATH", _dbPath);
        builder.UseSetting("B_ADMIN_TOKEN", AdminToken);
        foreach (var (k, v) in Settings) builder.UseSetting(k, v);
        builder.ConfigureServices(s => s.Replace(ServiceDescriptor.Singleton<TimeProvider>(Clock)));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        SqliteConnection.ClearAllPools();
        try { File.Delete(_dbPath); } catch (IOException) { }
    }
}
