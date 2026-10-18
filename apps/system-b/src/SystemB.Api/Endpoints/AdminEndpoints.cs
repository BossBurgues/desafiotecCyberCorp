using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SystemB.Api.Chaos;
using SystemB.Api.Models;

namespace SystemB.Api.Endpoints;

/// <summary>
/// Rotas de administração do B (fora de /api/v2 e do contrato). Exigem X-Admin-Token igual a B_ADMIN_TOKEN;
/// sem B_ADMIN_TOKEN configurado ficam desligadas.
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
    }
}
