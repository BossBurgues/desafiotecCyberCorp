using System.Net;

namespace SystemB.Tests;

/// <summary>Evidência de que o B é a caixa-preta do ADR-003: quem evita duplicata é o marcador do sync (ADR-004), não o B.</summary>
public class NoShortcutsTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public NoShortcutsTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    [Theory]
    [InlineData("externalId=glpi-42")]
    [InlineData("search=glpi-42")]
    [InlineData("ref=42")]
    [InlineData("q=glpi-42")]
    public async Task O_B_ignora_filtros_de_busca_e_devolve_a_lista_inteira(string query)
    {
        await _c.CreateId(Api.Body(description: "outro"));
        await _c.CreateId(Api.Body(description: "com marcador\n\n⟦s:glpi-42⟧"));
        await _c.CreateId(Api.Body(description: "mais um"));

        var page = await (await _c.GetAsync($"/api/v2/records?{query}")).Obj();
        Assert.Equal(3, page["items"]!.AsArray().Count);
        Assert.Equal(3, (int)page["total"]!);
    }

    [Theory]
    [InlineData("/api/v2/records/search?q=x")]
    [InlineData("/api/v2/search")]
    public async Task O_B_nao_tem_rota_de_busca(string url) =>
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync(url)).StatusCode);

    [Fact]
    public async Task O_mesmo_Idempotency_Key_cria_dois_registros()
    {
        async Task<HttpResponseMessage> Post()
        {
            var req = new HttpRequestMessage(HttpMethod.Post, "/api/v2/records") { Content = Api.Json(Api.Body()) };
            req.Headers.Add("Idempotency-Key", "abc");
            return await _c.SendAsync(req);
        }

        var first = await Post();
        var second = await Post();
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.NotEqual((string)(await first.Obj())["id"]!, (string)(await second.Obj())["id"]!);
        Assert.Equal(2, (int)(await (await _c.GetAsync("/api/v2/records")).Obj())["total"]!);
    }
}
