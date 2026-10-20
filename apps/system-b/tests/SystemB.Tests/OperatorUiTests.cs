using System.Net;
using System.Text.RegularExpressions;

namespace SystemB.Tests;

public class OperatorUiTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public OperatorUiTests() => _c = _f.CreateOperatorClient(options: new() { AllowAutoRedirect = false });

    public void Dispose() => _f.Dispose();

    private static string WwwRoot([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "../../src/SystemB.Api/wwwroot"));

    private async Task Chaos(string json)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, "/admin/chaos") { Content = Api.Json(json) };
        req.Headers.Add("X-Admin-Token", SystemBFactory.AdminToken);
        Assert.Equal(HttpStatusCode.OK, (await _c.SendAsync(req)).StatusCode);
    }

    [Theory]
    [InlineData("/ui/", "text/html")]
    [InlineData("/ui/app.js", "text/javascript")]
    [InlineData("/ui/styles.css", "text/css")]
    public async Task UI_e_servida_com_CSP_restrita(string path, string type)
    {
        var res = await _c.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(type, res.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("default-src 'self'", res.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
    }

    [Fact]
    public async Task Ui_sem_barra_redireciona_e_arquivo_fora_da_lista_responde_404()
    {
        var redirect = await _c.GetAsync("/ui");
        Assert.Equal(HttpStatusCode.Redirect, redirect.StatusCode);
        Assert.Equal("/ui/", redirect.Headers.Location!.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync("/ui/appsettings.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync("/ui/..%2Fappsettings.json")).StatusCode);
    }

    [Fact]
    public void Nenhum_arquivo_da_UI_monta_HTML_a_partir_de_texto()
    {
        var forbidden = new Regex(@"\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b|new Function\s*\(");
        var files = Directory.GetFiles(WwwRoot());
        Assert.NotEmpty(files);
        foreach (var file in files)
            Assert.False(forbidden.IsMatch(File.ReadAllText(file)), $"{Path.GetFileName(file)} usa construção de HTML insegura");
    }

    [Fact]
    public async Task Operador_lista_le_edita_muda_estado_e_reabre_sem_sofrer_caos()
    {
        var id = await _c.CreateId(Api.Body("Impressora", "Parou.\n\n⟦s:glpi-42⟧"));
        await Chaos("""{"errorRate":1}""");

        var page = await (await _c.GetAsync("/operator/records?page=1&pageSize=20")).Obj();
        Assert.Equal(1, (int)page["total"]!);

        var resolved = """{"title":"Impressora","description":"Parou.\n\n⟦s:glpi-42⟧","state":"RESOLVED","severity":"HIGH"}""";
        var res = await _c.PutAsync($"/operator/records/{id}", Api.Json(resolved));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var reopened = resolved.Replace("RESOLVED", "OPEN");
        Assert.Equal(HttpStatusCode.OK, (await _c.PutAsync($"/operator/records/{id}", Api.Json(reopened))).StatusCode);

        var read = await (await _c.GetAsync($"/operator/records/{id}")).Obj();
        Assert.Equal("OPEN", (string)read["state"]!);
        Assert.Equal("HIGH", (string)read["severity"]!);
        Assert.EndsWith("⟦s:glpi-42⟧", (string)read["description"]!);
    }

    [Fact]
    public async Task Operador_recebe_as_mesmas_validacoes_da_API()
    {
        var id = await _c.CreateId();
        Assert.Equal(HttpStatusCode.BadRequest, (await _c.PutAsync($"/operator/records/{id}", Api.Json("{"))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity,
            (await _c.PutAsync($"/operator/records/{id}", Api.Json(Api.Body(title: "")))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync("/operator/records/B-999")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.PutAsync("/operator/records/B-999", Api.Json(Api.Body()))).StatusCode);
    }

    [Fact]
    public async Task Edicao_do_operador_e_vista_pelo_sync_na_API()
    {
        var id = await _c.CreateId(Api.Body("antes"));
        await _c.PutAsync($"/operator/records/{id}", Api.Json(Api.Body("editado no B")));
        var viaApi = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.Equal("editado no B", (string)viaApi["title"]!);
    }
}
