using System.Text.Json;
using System.Text.RegularExpressions;
using SystemB.Api.Models;
using SystemB.Api.Storage;

namespace SystemB.Api.Endpoints;

/// <summary>
/// Rotas do operador do B, usadas pela UI. Ficam fora de /api/v2 e do contrato de propósito: o sync não pode depender
/// delas (ADR-003) e o caos não as atinge, para a demo continuar operável. Exigem login, mas sem papéis: todo operador
/// tem o mesmo acesso (o B é caixa-preta); o login serve para registrar quem alterou.
/// </summary>
public static partial class OperatorEndpoints
{
    public const string SessionHeader = "X-Session-Token";
    public const string OperatorItem = "operator";

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{2,31}$")]
    private static partial Regex LoginPattern();

    public sealed record RegisterInput(string? Login, string? Name, string? Password);
    public sealed record LoginInput(string? Login, string? Password);

    private static string Now(TimeProvider clock) => clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    private static IResult Unauthorized(string message) =>
        Results.Json(new ApiError(ApiError.Unauthorized, message), JsonDefaults.Options, statusCode: 401);

    private static async Task<T?> Read<T>(HttpRequest req) where T : class
    {
        try
        {
            return await req.ReadFromJsonAsync<T>(JsonDefaults.Options);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or BadHttpRequestException)
        {
            return null;
        }
    }

    /// <summary>Operador da sessão desta requisição (posto pelo filtro das rotas protegidas).</summary>
    public static Operator? Current(HttpContext ctx) => ctx.Items[OperatorItem] as Operator;

    public static void MapOperator(this WebApplication app)
    {
        var auth = app.MapGroup("/operator/auth");

        auth.MapPost("/register", async Task<IResult> (HttpRequest req, SqliteOperatorStore store, TimeProvider clock) =>
        {
            var input = await Read<RegisterInput>(req);
            if (input is null) return ErrorResults.BadRequest("JSON inválido");
            var login = (input.Login ?? "").Trim().ToLowerInvariant();
            var name = (input.Name ?? "").Trim();
            var problems = new List<string>();
            if (!LoginPattern().IsMatch(login))
                problems.Add("o usuário deve ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado");
            if (name.Length is < 1 or > 80) problems.Add("informe o nome (até 80 caracteres)");
            if (input.Password is not { Length: >= 8 and <= 128 }) problems.Add("a senha deve ter de 8 a 128 caracteres");
            if (problems.Count > 0) return ErrorResults.Validation(problems);

            var op = store.Register(login, name, input.Password!, Now(clock));
            return op is null
                ? Results.Json(new ApiError("CONFLICT", $"O usuário {login} já existe. Escolha outro ou entre com ele."), JsonDefaults.Options, statusCode: 409)
                : Results.Json(new { op.Login, op.Name }, JsonDefaults.Options, statusCode: 201);
        });

        auth.MapPost("/login", async Task<IResult> (HttpRequest req, SqliteOperatorStore store, TimeProvider clock) =>
        {
            var input = await Read<LoginInput>(req);
            if (input is null) return ErrorResults.BadRequest("JSON inválido");
            var session = store.Login((input.Login ?? "").Trim().ToLowerInvariant(), input.Password ?? "", Now(clock));
            return session is { } s
                ? Results.Json(new { s.Token, s.Operator.Login, s.Operator.Name }, JsonDefaults.Options)
                : Unauthorized("Usuário ou senha incorretos");
        });

        auth.MapGet("/me", (HttpRequest req, SqliteOperatorStore store) =>
            store.FindBySession(req.Headers[SessionHeader]) is { } op
                ? Results.Json(new { op.Login, op.Name }, JsonDefaults.Options)
                : Unauthorized("Sessão inválida ou expirada"));

        auth.MapPost("/logout", (HttpRequest req, SqliteOperatorStore store) =>
        {
            var token = req.Headers[SessionHeader].ToString();
            if (token.Length > 0) store.Logout(token);
            return Results.NoContent();
        });

        var g = app.MapGroup("/operator/records").AddEndpointFilter(async (ctx, next) =>
        {
            var http = ctx.HttpContext;
            var op = http.RequestServices.GetRequiredService<SqliteOperatorStore>().FindBySession(http.Request.Headers[SessionHeader]);
            if (op is null) return Unauthorized($"Entre na UI do operador ({SessionHeader} ausente ou inválido)");
            http.Items[OperatorItem] = op;
            return await next(ctx);
        });
        g.MapGet("/", RecordsEndpoints.List);
        g.MapGet("/{id}", RecordsEndpoints.Get);
        g.MapPut("/{id}", RecordsEndpoints.Put);
        // A exclusão do operador usa a mesma lápide da API: o sync vê o 410 com quem excluiu (ADR-015)
        g.MapDelete("/{id}", RecordsEndpoints.Delete);
    }
}
