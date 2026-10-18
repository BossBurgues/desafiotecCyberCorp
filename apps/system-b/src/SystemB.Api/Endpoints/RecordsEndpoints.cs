using System.Text.Json;
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

        g.MapGet("/{id}", (string id, IRecordStore store) =>
            store.Get(id) is { } r
                ? Results.Json(r, JsonDefaults.Options)
                : ErrorResults.NotFound($"Registro {id} não encontrado"));

        g.MapPut("/{id}", async Task<IResult> (string id, HttpRequest req, IRecordStore store, TimeProvider clock) =>
        {
            var (raw, err) = await ReadInput(req);
            if (err is not null) return err;
            var (input, problems) = RecordValidator.Validate(raw!);
            if (problems.Count > 0) return ErrorResults.Validation(problems);

            return store.Replace(id, input, Now(clock)) is { } r
                ? Results.Json(r, JsonDefaults.Options)
                : ErrorResults.NotFound($"Registro {id} não encontrado");
        });
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
