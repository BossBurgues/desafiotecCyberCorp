using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SystemB.Api.Models;
using SystemB.Api.Storage;
using SystemB.Api.Validation;

namespace SystemB.Api.Chaos;

/// <summary>O que a listagem deve distorcer nesta requisição (só existe dentro de /api/v2).</summary>
public sealed record ListChaos(int OffsetShift, string? CreatedAtOrBefore);

/// <summary>
/// Caos só na API do sync (/api/v2). /health, /operator, /admin e a UI ficam fora, para a demo continuar operável.
/// </summary>
public sealed class ChaosMiddleware(RequestDelegate next, ChaosEngine engine, IRecordStore store, TimeProvider clock)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        if (!ctx.Request.Path.StartsWithSegments("/api/v2"))
        {
            await next(ctx);
            return;
        }

        var o = engine.Options;
        var req = ctx.Request;
        var isWrite = HttpMethods.IsPost(req.Method) || HttpMethods.IsPut(req.Method);

        // O corpo vai para a memória antes de qualquer espera: no timeout o cliente desiste, mas a gravação tardia ainda acontece
        if (isWrite) await BufferBody(req, o.TruncateText);

        if (o.LatencyMs > 0) await Task.Delay(o.LatencyMs);

        if (HttpMethods.IsGet(req.Method) && IsListRoute(ctx))
            ctx.Features.Set(new ListChaos(engine.PageShift(), ListCutoff(o)));

        switch (engine.Decide(isWrite))
        {
            case Fault.RateLimit:
                ctx.Response.Headers.RetryAfter = "1";
                await WriteError(ctx, 429, "RATE_LIMITED", "Muitas requisições (caos)");
                return;
            case Fault.Error:
                await WriteError(ctx, engine.Next(0, 2) == 0 ? 500 : 503, ApiError.ChaosSimulated, "Falha simulada no Sistema B");
                return;
            case Fault.Timeout:
                // Segura a resposta além do timeout do cliente e depois processa normalmente (gravação tardia, cenário A2)
                await Task.Delay(o.TimeoutMs);
                await next(ctx);
                return;
            case Fault.AckWithoutPersist:
                if (!await AckWithoutPersist(ctx)) await next(ctx);
                return;
            case Fault.CommitThenFail:
                await RunAndReplace(ctx, 500, ApiError.ChaosSimulated, "Falha simulada depois de gravar");
                return;
            case Fault.OkWithErrorBody:
                await RunAndReplace(ctx, 200, ApiError.ChaosSimulated, "Falha simulada com status 200");
                return;
            default:
                await next(ctx);
                return;
        }
    }

    private static bool IsListRoute(HttpContext ctx) =>
        ctx.Request.Path.Value?.TrimEnd('/') == "/api/v2/records";

    private string? ListCutoff(ChaosOptions o) => o.ListDelayMs > 0
        ? clock.GetUtcNow().UtcDateTime.AddMilliseconds(-o.ListDelayMs).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
        : null;

    private static async Task BufferBody(HttpRequest req, int truncateText)
    {
        using var ms = new MemoryStream();
        await req.Body.CopyToAsync(ms);
        var bytes = ms.ToArray();
        if (truncateText > 0) bytes = Truncate(bytes, truncateText);
        req.Body = new MemoryStream(bytes);
        req.ContentLength = bytes.Length;
    }

    /// <summary>Corta a description como um B que limita o tamanho do texto: o marcador no fim é o primeiro a sumir (ADR-004).</summary>
    private static byte[] Truncate(byte[] body, int max)
    {
        try
        {
            if (JsonNode.Parse(body) is not JsonObject obj) return body;
            if (obj["description"] is not JsonValue v || !v.TryGetValue<string>(out var text) || text.Length <= max) return body;
            var cut = text[..max];
            if (char.IsHighSurrogate(cut[^1])) cut = cut[..^1];
            obj["description"] = cut;
            return Encoding.UTF8.GetBytes(obj.ToJsonString(JsonDefaults.Options));
        }
        catch (JsonException)
        {
            return body; // corpo inválido segue intacto para o handler devolver 400
        }
    }

    /// <summary>Responde sucesso sem gravar nada. Corpo inválido ou registro inexistente seguem o fluxo normal.</summary>
    private async Task<bool> AckWithoutPersist(HttpContext ctx)
    {
        RecordInput? raw;
        try
        {
            raw = await ctx.Request.ReadFromJsonAsync<RecordInput>(JsonDefaults.Options);
        }
        catch (JsonException)
        {
            raw = null;
        }
        ctx.Request.Body.Position = 0;
        if (raw is null) return false;
        var (input, problems) = RecordValidator.Validate(raw);
        if (problems.Count > 0) return false;

        var now = clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        if (HttpMethods.IsPost(ctx.Request.Method))
        {
            // ID alto e aleatório: nunca colide com os sequenciais, então a leitura posterior devolve 404 (cenário B5)
            var fake = Record.From($"B-{engine.Next(100_000_000, int.MaxValue)}", input, now, now);
            ctx.Response.Headers.Location = $"/api/v2/records/{fake.Id}";
            await WriteJson(ctx, 201, fake);
            return true;
        }

        if (ctx.GetRouteValue("id") is not string id || store.Get(id) is not { } existing) return false;
        await WriteJson(ctx, 200, Record.From(id, input, existing.CreatedAt, now));
        return true;
    }

    /// <summary>Executa o handler de verdade (grava) e troca a resposta por um erro.</summary>
    private async Task RunAndReplace(HttpContext ctx, int status, string code, string message)
    {
        var original = ctx.Response.Body;
        using var discard = new MemoryStream();
        ctx.Response.Body = discard;
        try
        {
            await next(ctx);
        }
        finally
        {
            ctx.Response.Body = original;
        }
        ctx.Response.Headers.Remove("Location");
        await WriteError(ctx, status, code, message);
    }

    private static Task WriteError(HttpContext ctx, int status, string code, string message) =>
        WriteJson(ctx, status, new ApiError(code, message));

    private static Task WriteJson<T>(HttpContext ctx, int status, T body)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength = null;
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(body, JsonDefaults.Options));
    }
}
