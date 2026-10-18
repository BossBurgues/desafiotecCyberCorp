using System.Net;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Admin do B (S2.5): perda de dados simulada (apagar um registro, wipe) e drift de formato.</summary>
public class AdminRecordsTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public AdminRecordsTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    private Task<HttpResponseMessage> Admin(HttpMethod m, string path, string? json = null, string? token = SystemBFactory.AdminToken)
    {
        var r = new HttpRequestMessage(m, path);
        if (token is not null) r.Headers.Add("X-Admin-Token", token);
        if (json is not null) r.Content = Api.Json(json);
        return _c.SendAsync(r);
    }

    private async Task<int> Total() => (int)(await (await _c.GetAsync("/api/v2/records")).Obj())["total"]!;

    [Fact]
    public async Task Apagar_um_registro_faz_a_leitura_responder_404_e_preserva_os_outros()
    {
        var keep = await _c.CreateId();
        var id = await _c.CreateId();

        Assert.Equal(HttpStatusCode.NoContent, (await Admin(HttpMethod.Delete, $"/admin/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync($"/api/v2/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _c.GetAsync($"/api/v2/records/{keep}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Admin(HttpMethod.Delete, $"/admin/records/{id}")).StatusCode);
    }

    [Fact]
    public async Task Wipe_apaga_tudo_e_informa_quantos()
    {
        for (var i = 0; i < 3; i++) await _c.CreateId();

        var res = await Admin(HttpMethod.Post, "/admin/wipe");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(3, (int)(await res.Obj())["deleted"]!);
        Assert.Equal(0, await Total());
    }

    [Fact]
    public async Task Depois_do_wipe_um_ID_antigo_nunca_aponta_para_outro_registro()
    {
        var old = await _c.CreateId();
        await Admin(HttpMethod.Post, "/admin/wipe");

        var fresh = await _c.CreateId();
        Assert.NotEqual(old, fresh);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync($"/api/v2/records/{old}")).StatusCode);
    }

    [Theory]
    [InlineData("DELETE", "/admin/records/B-1")]
    [InlineData("POST", "/admin/wipe")]
    public async Task Sem_token_nada_e_apagado(string method, string path)
    {
        var id = await _c.CreateId();
        Assert.Equal("B-1", id);

        Assert.Equal(HttpStatusCode.Unauthorized, (await Admin(new HttpMethod(method), path, token: null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Admin(new HttpMethod(method), path, token: "errado")).StatusCode);
        Assert.Equal(1, await Total());
    }

    [Fact]
    public async Task Drift_renomeia_title_no_registro_e_em_cada_item_da_listagem()
    {
        var id = await _c.CreateId(Api.Body("antes do drift"));
        Assert.Equal(HttpStatusCode.OK, (await Admin(HttpMethod.Put, "/admin/chaos", """{"formatDrift":true}""")).StatusCode);

        var one = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.False(one.ContainsKey("title"));
        Assert.Equal("antes do drift", (string)one["summary"]!);

        var page = await (await _c.GetAsync("/api/v2/records")).Obj();
        var item = page["items"]!.AsArray().Single()!.AsObject();
        Assert.False(item.ContainsKey("title"));
        Assert.Equal("antes do drift", (string)item["summary"]!);

        var created = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body("novo")));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal("novo", (string)(await created.Obj())["summary"]!);
    }

    [Fact]
    public async Task Drift_nao_mexe_no_dado_gravado_nem_nos_erros_nem_fora_de_api_v2()
    {
        var id = await _c.CreateId(Api.Body("intacto"));
        await Admin(HttpMethod.Put, "/admin/chaos", """{"formatDrift":true}""");

        var notFound = await (await _c.GetAsync("/api/v2/records/B-999")).Obj();
        Assert.Equal(["error", "message"], notFound.Select(p => p.Key).Order());

        var op = await (await _c.GetAsync($"/operator/records/{id}")).Obj();
        Assert.Equal("intacto", (string)op["title"]!);

        await Admin(HttpMethod.Put, "/admin/chaos", "{}");
        Assert.Equal("intacto", (string)(await (await _c.GetAsync($"/api/v2/records/{id}")).Obj())["title"]!);
    }

    [Fact]
    public async Task Drift_ligado_pelo_ambiente_vale_desde_a_subida()
    {
        using var f = new SystemBFactory { Settings = { ["B_CHAOS_FORMAT_DRIFT"] = "true" } };
        var c = f.CreateClient();
        var id = await c.CreateId();
        var rec = await (await c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.True(rec.ContainsKey("summary"));
    }
}
