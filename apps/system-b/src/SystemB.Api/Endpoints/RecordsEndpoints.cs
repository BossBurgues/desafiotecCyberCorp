using System.Text.Json;
using SystemB.Api.Chaos;
using SystemB.Api.Models;
using SystemB.Api.Storage;
using SystemB.Api.Validation;

namespace SystemB.Api.Endpoints;

public static class RecordsEndpoints
{
    private static string Now(TimeProvider clock) =>
        clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    /// <summary>Lê e desserializa o corpo; qualquer falha de formato vira 400.</summary>
    private static async Task<(RecordInput? Input, IResult? Error)> ReadInput(HttpRequest req)
    {
        try
        {
            var input = await req.ReadFromJsonAsync<RecordInput>(JsonDefaults.Options);
            return input is null ? (null, ErrorResults.BadRequest("Corpo vazio")) : (input, null);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or BadHttpRequestException)
        {
            return (null, ErrorResults.BadRequest("JSON inválido: " + e.Message));
        }
    }

    private static bool TryInt(string? raw, int fallback, int min, int max, out int value)
    {
        if (string.IsNullOrEmpty(raw)) { value = fallback; return true; }
        return int.TryParse(raw, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out value)
               && value >= min && value <= max;
    }

    public static void MapRecords(this WebApplication app)
    {
        var g = app.MapGroup("/api/v2/records");

        g.MapPost("/", async Task<IResult> (HttpRequest req, IRecordStore store, TimeProvider clock) =>
        {
            var (raw, err) = await ReadInput(req);
            if (err is not null) return err;
            var (input, problems) = RecordValidator.Validate(raw!);
            if (problems.Count > 0) return ErrorResults.Validation(problems);

            var created = store.Create(input, Now(clock));
            return new CreatedJson(Results.Json(created, JsonDefaults.Options, statusCode: 201), $"/api/v2/records/{created.Id}");
        });

        g.MapGet("/", List);
        g.MapGet("/{id}", Get);
        g.MapPut("/{id}", Put);
    }

    // Handlers compartilhados com as rotas do operador (/operator/records), que ficam fora do caos

    public static IResult List(HttpRequest req, IRecordStore store)
    {
        // Parâmetros desconhecidos (externalId, search, ref, q...) são ignorados de propósito: o B não filtra.
        if (!TryInt(req.Query["page"], 1, 1, int.MaxValue, out var page))
            return ErrorResults.BadRequest("page deve ser um inteiro >= 1");
        if (!TryInt(req.Query["pageSize"], 50, 1, 200, out var pageSize))
            return ErrorResults.BadRequest("pageSize deve ser um inteiro entre 1 e 200");

        // Distorções do caos (paginação instável e atraso de listagem); fora de /api/v2 não existem
        var chaos = req.HttpContext.Features.Get<ListChaos>();
        var offset = Math.Max(0, (long)(page - 1) * pageSize + (chaos?.OffsetShift ?? 0));
        var cutoff = chaos?.CreatedAtOrBefore;
        var items = offset > int.MaxValue ? [] : store.List((int)offset, pageSize, cutoff);
        return Results.Json(new RecordPage(items, page, pageSize, store.Count(cutoff)), JsonDefaults.Options);
    }

    public static IResult Get(string id, IRecordStore store) =>
        store.Get(id) is { } r
            ? Results.Json(r, JsonDefaults.Options)
            : ErrorResults.NotFound($"Registro {id} não encontrado");

    public static async Task<IResult> Put(string id, HttpRequest req, IRecordStore store, TimeProvider clock)
    {
        var (raw, err) = await ReadInput(req);
        if (err is not null) return err;
        var (input, problems) = RecordValidator.Validate(raw!);
        if (problems.Count > 0) return ErrorResults.Validation(problems);

        return store.Replace(id, input, Now(clock)) is { } r
            ? Results.Json(r, JsonDefaults.Options)
            : ErrorResults.NotFound($"Registro {id} não encontrado");
    }
}

internal sealed class CreatedJson(IResult inner, string location) : IResult
{
    public Task ExecuteAsync(HttpContext ctx)
    {
        ctx.Response.Headers.Location = location;
        return inner.ExecuteAsync(ctx);
    }
}
