using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Cada falha do caos vista de fora, como o sync a veria.</summary>
public class ChaosApiTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public ChaosApiTests() => _c = _f.CreateOperatorClient();

    public void Dispose() => _f.Dispose();

    private async Task Chaos(string json)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, "/admin/chaos") { Content = Api.Json(json) };
        req.Headers.Add("X-Admin-Token", SystemBFactory.AdminToken);
        var res = await _c.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    private Task Calm() => Chaos("{}");

    private async Task<int> Total() => (int)(await (await _c.GetAsync("/api/v2/records")).Obj())["total"]!;

    [Fact]
    public async Task Erro_5xx_nao_grava_nada()
    {
        await Chaos("""{"seed":1,"errorRate":1}""");
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body()));
        Assert.True((int)res.StatusCode is 500 or 503, res.StatusCode.ToString());
        Assert.Equal("CHAOS_SIMULATED_ERROR", (string)(await res.Obj())["error"]!);
        await Calm();
        Assert.Equal(0, await Total());
    }

    [Fact]
    public async Task Grava_e_devolve_500_o_registro_existe_mesmo_com_o_erro()
    {
        await Chaos("""{"commitThenFailRate":1}""");
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body("commit-then-fail")));
        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        Assert.False(res.Headers.Contains("Location"));
        await Calm();
        Assert.Equal(1, await Total());
    }

    [Fact]
    public async Task Ack_sem_gravar_devolve_201_com_id_que_nao_existe()
    {
        await Chaos("""{"seed":3,"ackWithoutPersistRate":1}""");
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body("fantasma")));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var id = (string)(await res.Obj())["id"]!;
        await Calm();
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync($"/api/v2/records/{id}")).StatusCode);
        Assert.Equal(0, await Total());
    }

    [Fact]
    public async Task Ack_sem_gravar_no_PUT_devolve_200_e_mantem_o_valor_antigo()
    {
        var id = await _c.CreateId(Api.Body("antes"));
        await Chaos("""{"ackWithoutPersistRate":1}""");
        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body("depois")));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("depois", (string)(await res.Obj())["title"]!);
        await Calm();
        Assert.Equal("antes", (string)(await (await _c.GetAsync($"/api/v2/records/{id}")).Obj())["title"]!);
    }

    [Fact]
    public async Task Ack_sem_gravar_nao_mascara_validacao_nem_404()
    {
        await Chaos("""{"ackWithoutPersistRate":1}""");
        Assert.Equal(HttpStatusCode.BadRequest, (await _c.PostAsync("/api/v2/records", Api.Json("{"))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity,
            (await _c.PostAsync("/api/v2/records", Api.Json(Api.Body(title: " ")))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.PutAsync("/api/v2/records/B-999", Api.Json(Api.Body()))).StatusCode);
    }

    [Fact]
    public async Task Status_200_com_corpo_de_erro_e_o_registro_gravado()
    {
        await Chaos("""{"okWithErrorBodyRate":1}""");
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body()));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Obj();
        Assert.Equal(["error", "message"], body.Select(p => p.Key).Order());
        await Calm();
        Assert.Equal(1, await Total());
    }

    [Fact]
    public async Task Rate_limit_devolve_429_com_Retry_After_e_nao_grava()
    {
        await Chaos("""{"rateLimitRate":1}""");
        var res = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body()));
        Assert.Equal((HttpStatusCode)429, res.StatusCode);
        Assert.Equal("1", res.Headers.GetValues("Retry-After").Single());
        await Calm();
        Assert.Equal(0, await Total());
    }

    [Fact]
    public async Task Timeout_o_cliente_desiste_e_a_gravacao_acontece_depois()
    {
        await Chaos("""{"timeoutRate":1,"timeoutMs":400}""");
        using var impatient = _f.CreateClient();
        impatient.Timeout = TimeSpan.FromMilliseconds(100);
        await Assert.ThrowsAnyAsync<TaskCanceledException>(() =>
            impatient.PostAsync("/api/v2/records", Api.Json(Api.Body("tardio"))));

        await Calm();
        var deadline = Stopwatch.StartNew();
        while (await Total() == 0 && deadline.ElapsedMilliseconds < 5_000) await Task.Delay(50);
        Assert.Equal(1, await Total());
    }

    [Fact]
    public async Task Latencia_atrasa_cada_requisicao()
    {
        await Chaos("""{"latencyMs":250}""");
        var sw = Stopwatch.StartNew();
        await _c.GetAsync("/api/v2/records");
        Assert.True(sw.ElapsedMilliseconds >= 240, $"{sw.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task Texto_truncado_corta_a_description_e_o_marcador_some()
    {
        await Chaos("""{"truncateText":10}""");
        var id = await _c.CreateId(Api.Body(description: "Descrição longa ⟦s:glpi-42⟧"));
        var desc = (string)(await (await _c.GetAsync($"/api/v2/records/{id}")).Obj())["description"]!;
        Assert.Equal("Descrição ", desc);
        Assert.DoesNotContain("⟦s:glpi-42⟧", desc);
    }

    [Fact]
    public async Task Paginacao_instavel_pula_ou_repete_itens()
    {
        for (var i = 1; i <= 5; i++) await _c.CreateId(Api.Body($"r{i}"));

        async Task<string[]> Page2()
        {
            var page = await (await _c.GetAsync("/api/v2/records?page=2&pageSize=2")).Obj();
            return page["items"]!.AsArray().Select(x => (string)x!["title"]!).ToArray();
        }

        Assert.Equal(["r3", "r4"], await Page2());
        await Chaos("""{"pageSkipRate":1}""");
        Assert.Equal(["r4", "r5"], await Page2());
        await Chaos("""{"pageRepeatRate":1}""");
        Assert.Equal(["r2", "r3"], await Page2());
    }

    [Fact]
    public async Task Atraso_de_listagem_esconde_o_registro_recem_criado()
    {
        await Chaos("""{"listDelayMs":60000}""");
        var id = await _c.CreateId();
        Assert.Equal(0, await Total());
        Assert.Equal(HttpStatusCode.OK, (await _c.GetAsync($"/api/v2/records/{id}")).StatusCode);

        _f.Clock.Advance(TimeSpan.FromSeconds(61));
        Assert.Equal(1, await Total());
    }

    [Fact]
    public async Task Caos_nao_afeta_health_nem_rotas_do_operador()
    {
        var id = await _c.CreateId();
        await Chaos("""{"errorRate":1}""");
        Assert.Equal(HttpStatusCode.OK, (await _c.GetAsync("/health")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _c.DeleteAsync($"/operator/records/{id}")).StatusCode);
    }

    [Fact]
    public async Task Caos_configurado_por_ambiente_vale_desde_a_subida()
    {
        using var f = new SystemBFactory { Settings = { ["B_CHAOS_RATE_LIMIT_RATE"] = "1", ["B_CHAOS_SEED"] = "9" } };
        var c = f.CreateClient();
        Assert.Equal((HttpStatusCode)429, (await c.GetAsync("/api/v2/records")).StatusCode);

        // reset volta para o que veio do ambiente, não para "sem caos"
        var reset = new HttpRequestMessage(HttpMethod.Post, "/admin/chaos/reset");
        reset.Headers.Add("X-Admin-Token", SystemBFactory.AdminToken);
        var body = await (await c.SendAsync(reset)).Obj();
        Assert.Equal(1.0, (double)body["rateLimitRate"]!);
        Assert.Equal(9, (int)body["seed"]!);
    }
}

public class AdminAuthTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public AdminAuthTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    private HttpRequestMessage Req(HttpMethod m, string path, string? token, string? json = null)
    {
        var r = new HttpRequestMessage(m, path);
        if (token is not null) r.Headers.Add("X-Admin-Token", token);
        if (json is not null) r.Content = Api.Json(json);
        return r;
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("errado")]
    [InlineData("test-admin-token-")]
    public async Task Sem_token_ou_com_token_errado_responde_401(string? token)
    {
        var res = await _c.SendAsync(Req(HttpMethod.Get, "/admin/chaos", token));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("UNAUTHORIZED", (string)(await res.Obj())["error"]!);
    }

    [Fact]
    public async Task Sem_B_ADMIN_TOKEN_configurado_o_admin_fica_desligado()
    {
        using var f = new SystemBFactory { Settings = { ["B_ADMIN_TOKEN"] = "" } };
        var res = await f.CreateClient().SendAsync(Req(HttpMethod.Get, "/admin/chaos", ""));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Configuracao_valida_e_devolvida_e_lida_de_volta()
    {
        var put = await _c.SendAsync(Req(HttpMethod.Put, "/admin/chaos", SystemBFactory.AdminToken, """{"seed":5,"errorRate":0.2}"""));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var get = await (await _c.SendAsync(Req(HttpMethod.Get, "/admin/chaos", SystemBFactory.AdminToken))).Obj();
        Assert.Equal(0.2, (double)get["errorRate"]!);
        Assert.Equal(5, (int)get["seed"]!);
        Assert.Equal(30000, (int)get["timeoutMs"]!);
    }

    [Theory]
    [InlineData("""{"errorRate":2}""", HttpStatusCode.UnprocessableEntity)]
    [InlineData("""{"errorRate":0.6,"timeoutRate":0.6}""", HttpStatusCode.UnprocessableEntity)]
    [InlineData("""{"campoQueNaoExiste":1}""", HttpStatusCode.BadRequest)]
    [InlineData("""{ nao e json""", HttpStatusCode.BadRequest)]
    public async Task Configuracao_invalida_e_recusada_e_nada_muda(string json, HttpStatusCode expected)
    {
        var res = await _c.SendAsync(Req(HttpMethod.Put, "/admin/chaos", SystemBFactory.AdminToken, json));
        Assert.Equal(expected, res.StatusCode);
        var get = await (await _c.SendAsync(Req(HttpMethod.Get, "/admin/chaos", SystemBFactory.AdminToken))).Obj();
        Assert.Equal(0.0, (double)get["errorRate"]!);
    }
}
