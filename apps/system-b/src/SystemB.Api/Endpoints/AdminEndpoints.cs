using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SystemB.Api.Chaos;
using SystemB.Api.Models;
using SystemB.Api.Storage;

namespace SystemB.Api.Endpoints;

/// <summary>
/// Rotas de administração do B (fora de /api/v2 e do contrato): caos, drift de formato, apagar um registro e wipe.
/// Exigem X-Admin-Token igual a B_ADMIN_TOKEN; sem B_ADMIN_TOKEN configurado ficam desligadas.
/// </summary>
public static class AdminEndpoints
{
    public const string TokenHeader = "X-Admin-Token";

    public static void MapAdmin(this WebApplication app)
    {
        var token = app.Configuration["B_ADMIN_TOKEN"];
        var g = app.MapGroup("/admin").AddEndpointFilter(async (ctx, next) =>
        {
            if (string.IsNullOrEmpty(token))
                return Results.Json(new ApiError(ApiError.Forbidden, "Admin desligado: defina B_ADMIN_TOKEN"), JsonDefaults.Options, statusCode: 403);
            var sent = ctx.HttpContext.Request.Headers[TokenHeader].ToString();
            // Comparação em tempo constante: o tempo de resposta não revela quantos caracteres batem
            var ok = CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(sent), Encoding.UTF8.GetBytes(token));
            return ok
                ? await next(ctx)
                : Results.Json(new ApiError(ApiError.Unauthorized, $"{TokenHeader} ausente ou inválido"), JsonDefaults.Options, statusCode: 401);
        });

        g.MapGet("/chaos", (ChaosEngine engine) => Results.Json(engine.Options, JsonDefaults.Options));

        // Substitui a configuração inteira: campo ausente volta ao padrão (0 = desligado)
        g.MapPut("/chaos", async Task<IResult> (HttpRequest req, ChaosEngine engine) =>
        {
            ChaosOptions? options;
            try
            {
                options = await req.ReadFromJsonAsync<ChaosOptions>(JsonDefaults.Options);
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or BadHttpRequestException)
            {
                return ErrorResults.BadRequest("JSON inválido: " + e.Message);
            }
            if (options is null) return ErrorResults.BadRequest("Corpo vazio");
            var problems = options.Validate();
            if (problems.Count > 0) return ErrorResults.Validation(problems);
            engine.Configure(options);
            return Results.Json(engine.Options, JsonDefaults.Options);
        });

        g.MapPost("/chaos/reset", (ChaosEngine engine) =>
        {
            engine.Reset();
            return Results.Json(engine.Options, JsonDefaults.Options);
        });

        // Perda de dados simulada: some do B sem passar pela UI do operador (autocura pelo auditor, cenários D)
        g.MapDelete("/records/{id}", (string id, IRecordStore store) =>
            store.Delete(id) ? Results.NoContent() : ErrorResults.NotFound($"Registro {id} não encontrado"));

        g.MapPost("/wipe", (IRecordStore store) => Results.Json(new { deleted = store.Wipe() }, JsonDefaults.Options));
    }
}
