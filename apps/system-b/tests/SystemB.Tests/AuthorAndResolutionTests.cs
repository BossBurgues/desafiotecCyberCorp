using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Capacidades opcionais do B → A leve: quem alterou (updatedBy) e o texto da solução (resolution).</summary>
public class AuthorAndResolutionTests : IClassFixture<SystemBFactory>
{
    private readonly SystemBFactory _f;
    private readonly HttpClient _c;

    public AuthorAndResolutionTests(SystemBFactory f)
    {
        _f = f;
        _c = f.CreateOperatorClient("Carla (suporte terceirizado)");
    }

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

        // O autor é o nome da conta que entrou; um X-Operator no cabeçalho não muda nada
        var req = new HttpRequestMessage(HttpMethod.Put, $"/operator/records/{id}") { Content = Api.Json(body.ToJsonString()) };
        req.Headers.Add("X-Operator", "Outra Pessoa");
        var res = await _c.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var got = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.Equal("RESOLVED", (string)got["state"]!);
        Assert.Equal("Toner trocado.", (string)got["resolution"]!);
        Assert.Equal("Carla (suporte terceirizado)", (string)got["updatedBy"]!);
    }

    [Fact]
    public async Task Rotas_do_operador_sem_sessao_respondem_401_e_a_API_do_sync_nao_pede_login()
    {
        var anon = _f.CreateClient();
        var created = await Create();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/operator/records")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.DeleteAsync($"/operator/records/{(string)created["id"]!}")).StatusCode);
        var bad = new HttpRequestMessage(HttpMethod.Get, "/operator/records");
        bad.Headers.Add("X-Session-Token", "token-inventado");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.SendAsync(bad)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await anon.GetAsync("/api/v2/records")).StatusCode);
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
