using System.Text.Json;
using SystemB.Api.Chaos;
using SystemB.Api.Endpoints;
using SystemB.Api.Models;
using SystemB.Api.Storage;

// HEALTHCHECK do Docker: a imagem aspnet não tem curl, então o próprio binário consulta /health e sai
if (args is ["--healthcheck"])
{
    var urls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://0.0.0.0:5002";
    var port = System.Text.RegularExpressions.Regex.Match(urls, @":(\d+)").Groups[1].Value;
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    try
    {
        var res = await http.GetAsync($"http://127.0.0.1:{port}/health");
        return res.IsSuccessStatusCode ? 0 : 1;
    }
    catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
    {
        return 1;
    }
}

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.UseUrls(builder.Configuration["ASPNETCORE_URLS"] ?? "http://0.0.0.0:5002");

builder.Services.ConfigureHttpJsonOptions(o =>
{
    var d = JsonDefaults.Options;
    o.SerializerOptions.PropertyNamingPolicy = d.PropertyNamingPolicy;
    o.SerializerOptions.DefaultIgnoreCondition = d.DefaultIgnoreCondition;
    o.SerializerOptions.Encoder = d.Encoder;
    foreach (var c in d.Converters) o.SerializerOptions.Converters.Add(c);
});
builder.Services.AddSingleton(TimeProvider.System);
var dbPath = builder.Configuration["B_DB_PATH"] ?? "./data/system-b.db";
builder.Services.AddSingleton<IRecordStore>(_ => new SqliteRecordStore(dbPath));
builder.Services.AddSingleton(_ => new SqliteOperatorStore(dbPath));
builder.Services.AddSingleton<AuthThrottle>();
// Criado quando o pipeline monta o middleware, na subida: B_CHAOS_* inválido derruba o processo antes de atender
builder.Services.AddSingleton(sp => new ChaosEngine(ChaosOptions.FromConfiguration(sp.GetRequiredService<IConfiguration>())));

var app = builder.Build();

app.UseExceptionHandler(errorApp => errorApp.Run(async ctx =>
{
    ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
    await ctx.Response.WriteAsJsonAsync(new ApiError(ApiError.Internal, "Erro interno do Sistema B"));
}));

app.UseMiddleware<ChaosMiddleware>();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapRecords();
app.MapOperator();
app.MapAdmin();
app.MapUi();

app.MapFallback(() => Results.Json(new ApiError(ApiError.NotFound, "Rota não encontrada"), statusCode: 404));

await app.RunAsync();
return 0;

public partial class Program;
