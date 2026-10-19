using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Capacidades opcionais do B → A leve: quem alterou (updatedBy) e o texto da solução (resolution).</summary>
public class AuthorAndResolutionTests : IClassFixture<SystemBFactory>
{
    private readonly HttpClient _c;

    public AuthorAndResolutionTests(SystemBFactory f) { _c = f.CreateClient(); }

    private async Task<JsonObject> Create() =>
        await (await _c.PostAsync("/api/v2/records", Api.Json(Api.Body()))).Obj();

    [Fact]
    public async Task Escrita_pela_API_do_sync_fica_com_autor_integracao()
    {
        var created = await Create();
        Assert.Equal("integração (sync)", (string)created["updatedBy"]!);
    }

    [Fact]
    public async Task Operador_resolve_com_texto_da_solucao_e_o_nome_dele_fica_como_autor()
    {
        var created = await Create();
        var id = (string)created["id"]!;
        var body = created.DeepClone().AsObject();
        foreach (var ro in new[] { "id", "createdAt", "updatedAt", "updatedBy" }) body.Remove(ro);
        body["state"] = "RESOLVED";
        body["resolution"] = "Toner trocado.";

        var req = new HttpRequestMessage(HttpMethod.Put, $"/operator/records/{id}") { Content = Api.Json(body.ToJsonString()) };
        req.Headers.Add("X-Operator", "Carla (suporte terceirizado)");
        var res = await _c.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var got = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.Equal("RESOLVED", (string)got["state"]!);
        Assert.Equal("Toner trocado.", (string)got["resolution"]!);
        Assert.Equal("Carla (suporte terceirizado)", (string)got["updatedBy"]!);
    }

    [Fact]
    public async Task Operador_sem_nome_vira_Operador_B()
    {
        var created = await Create();
        var body = created.DeepClone().AsObject();
        foreach (var ro in new[] { "id", "createdAt", "updatedAt", "updatedBy" }) body.Remove(ro);
        var res = await _c.PutAsync($"/operator/records/{(string)created["id"]!}", Api.Json(body.ToJsonString()));
        Assert.Equal("Operador B", (string)(await res.Obj())["updatedBy"]!);
    }

    [Fact]
    public async Task Solucao_com_mais_de_2000_caracteres_responde_422()
    {
        var body = JsonNode.Parse(Api.Body())!.AsObject();
        body["resolution"] = new string('x', 2001);
        var res = await _c.PostAsync("/api/v2/records", Api.Json(body.ToJsonString()));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }
}
