namespace SystemB.Api.Endpoints;

/// <summary>UI do Operador B em /ui, servida de wwwroot.</summary>
public static class UiEndpoints
{
    // Lista fechada: nenhum caminho vem da URL, então não há path traversal possível
    private static readonly Dictionary<string, string> Files = new()
    {
        ["index.html"] = "text/html; charset=utf-8",
        ["app.js"] = "text/javascript; charset=utf-8",
        ["styles.css"] = "text/css; charset=utf-8",
    };

    private const string Csp =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

    public static void MapUi(this WebApplication app)
    {
        // Arquivo ausente lança aqui: o servidor não sobe com a UI incompleta
        var assets = Files.ToDictionary(f => f.Key, f => File.ReadAllBytes(Path.Combine(app.Environment.WebRootPath, f.Key)));

        IResult Serve(HttpContext ctx, string name)
        {
            if (!assets.TryGetValue(name, out var body)) return ErrorResults.NotFound("Arquivo da UI não encontrado");
            ctx.Response.Headers.ContentSecurityPolicy = Csp;
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            // Revalida a cada carga: depois de um deploy o navegador nunca fica com o app.js antigo
            ctx.Response.Headers.CacheControl = "no-cache";
            return Results.Bytes(body, Files[name]);
        }

        // Uma rota só: "/ui" e "/ui/" casam com o mesmo padrão, e duas rotas ali seriam ambíguas
        app.MapGet("/ui/{file?}", (HttpContext ctx, string? file) =>
            file is not null ? Serve(ctx, file)
            : ctx.Request.Path.Value!.EndsWith('/') ? Serve(ctx, "index.html")
            : Results.Redirect("/ui/"));
    }
}
