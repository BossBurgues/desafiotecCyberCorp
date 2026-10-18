using System.Net;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

public class RecordsApiTests : IClassFixture<SystemBFactory>
{
    private readonly SystemBFactory _f;
    private readonly HttpClient _c;

    public RecordsApiTests(SystemBFactory f) { _f = f; _c = f.CreateClient(); }

    // ---- erros

    [Theory]
    [InlineData("{ nao e json")]
    [InlineData("null")]
    [InlineData("""{"title":"t","description":"d","state":"DONE","severity":"LOW"}""")]
    [InlineData("""{"title":"t","description":"d","state":"OPEN","severity":"LOW","foo":1}""")]
    [InlineData("""{"id":"B-1","title":"t","description":"d","state":"OPEN","severity":"LOW"}""")]
    [InlineData("""{"title":"t","state":"OPEN","severity":"LOW"}""")]
    public async Task Corpo_malformado_ou_com_campo_desconhecido_responde_400(string body)
    {
        var res = await _c.PostAsync("/api/v2/records", Api.Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("BAD_REQUEST", (string)(await res.Obj())["error"]!);
    }

    [Fact]
    public async Task Regra_de_dominio_violada_responde_422()
    {
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body(title: new string('a', 201))));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("VALIDATION_ERROR", (string)(await res.Obj())["error"]!);
    }

    [Fact]
    public async Task Todo_corpo_de_erro_tem_exatamente_error_e_message()
    {
        var responses = new[]
        {
            await _c.PostAsync("/api/v2/records", Api.Json("{")),
            await _c.PostAsync("/api/v2/records", Api.Json(Api.Body(title: " "))),
            await _c.GetAsync("/api/v2/records/B-99999"),
            await _c.GetAsync("/rota/que/nao/existe"),
        };
        foreach (var res in responses)
        {
            var o = await res.Obj();
            Assert.Equal(["error", "message"], o.Select(kv => kv.Key).Order());
            Assert.NotNull(o["error"]!.GetValue<string>());
            Assert.NotNull(o["message"]!.GetValue<string>());
        }
        Assert.Equal(HttpStatusCode.NotFound, responses[3].StatusCode);
    }

    // ---- criar e ler

    [Fact]
    public async Task Criar_devolve_201_com_Location_e_o_GET_devolve_o_mesmo_registro()
    {
        var created = await _c.PostAsync("/api/v2/records", Api.Json(Api.Sample));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await created.Obj();
        var id = (string)body["id"]!;
        Assert.Equal($"/api/v2/records/{id}", created.Headers.Location!.OriginalString);
        Assert.Equal((string)body["createdAt"]!, (string)body["updatedAt"]!);

        var got = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        var sent = JsonNode.Parse(Api.Sample)!.AsObject();
        foreach (var (key, value) in sent)
            Assert.True(JsonNode.DeepEquals(value, got[key]), $"campo {key} diferente");
        Assert.Equal("A impressora parou.\n\n⟦s:glpi-42⟧", (string)got["description"]!);
    }

    [Fact]
    public async Task Description_volta_exatamente_como_foi_gravada()
    {
        var text = "  espaços, \r\n quebras\n\n e ⟦s:glpi-42⟧  ";
        var id = await _c.CreateId(Api.Body(description: text));
        var got = await (await _c.GetAsync($"/api/v2/records/{id}")).Obj();
        Assert.Equal(text, (string)got["description"]!);
    }

    [Fact]
    public async Task Title_e_aparado_ao_gravar()
    {
        var id = await _c.CreateId(Api.Body(title: "  abc  "));
        Assert.Equal("abc", (string)(await (await _c.GetAsync($"/api/v2/records/{id}")).Obj())["title"]!);
    }

    [Fact]
    public async Task Ler_id_inexistente_responde_404()
    {
        var res = await _c.GetAsync("/api/v2/records/B-424242");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("NOT_FOUND", (string)(await res.Obj())["error"]!);
    }

    // ---- PUT

    [Fact]
    public async Task Put_substitui_tudo_preserva_createdAt_e_avanca_updatedAt()
    {
        var created = await (await _c.PostAsync("/api/v2/records", Api.Json(Api.Sample))).Obj();
        var id = (string)created["id"]!;
        _f.Clock.Advance(TimeSpan.FromMinutes(5));

        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body(title: "novo")));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var put = await res.Obj();

        Assert.Equal((string)created["createdAt"]!, (string)put["createdAt"]!);
        Assert.NotEqual((string)created["updatedAt"]!, (string)put["updatedAt"]!);
        Assert.Equal("novo", (string)put["title"]!);
        Assert.Null(put["category"]);
        Assert.Null(put["location"]);
        Assert.Empty(put["attachments"]!.AsArray());
        Assert.True(JsonNode.DeepEquals(put, await (await _c.GetAsync($"/api/v2/records/{id}")).Obj()));
    }

    [Fact]
    public async Task Put_em_id_inexistente_responde_404()
    {
        var res = await _c.PutAsync("/api/v2/records/B-424242", Api.Json(Api.Body()));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Theory]
    [InlineData("id")]
    [InlineData("createdAt")]
    [InlineData("updatedBy")]
    public async Task Put_com_campo_somente_leitura_responde_400(string field)
    {
        var id = await _c.CreateId();
        var body = JsonNode.Parse(Api.Body())!.AsObject();
        body[field] = "x";
        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(body.ToJsonString()));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Put_com_dado_invalido_responde_422()
    {
        var id = await _c.CreateId();
        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body(title: "")));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }

    // Quando a S2.7 (ETag) entrar, este teste deve ser trocado: hoje o If-Match é ignorado.
    [Fact]
    public async Task If_Match_e_ignorado_ate_a_S2_7_implementar_ETag()
    {
        var id = await _c.CreateId();
        var req = new HttpRequestMessage(HttpMethod.Put, $"/api/v2/records/{id}") { Content = Api.Json(Api.Body(title: "x")) };
        req.Headers.TryAddWithoutValidation("If-Match", "\"qualquer\"");
        var res = await _c.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.False(res.Headers.Contains("ETag"));
    }
}
