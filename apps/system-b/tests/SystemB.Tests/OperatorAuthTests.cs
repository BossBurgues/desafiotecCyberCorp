using System.Net;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Contas do operador do B: cadastro, login, quem sou eu e sair. Sem papéis: toda conta tem o mesmo acesso.</summary>
public class OperatorAuthTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public OperatorAuthTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    private static StringContent Account(string login, string name = "Maria Silva", string password = "senha-forte-1") =>
        Api.Json(new JsonObject { ["login"] = login, ["name"] = name, ["password"] = password }.ToJsonString());

    private static StringContent Credentials(string login, string password = "senha-forte-1") =>
        Api.Json(new JsonObject { ["login"] = login, ["password"] = password }.ToJsonString());

    [Fact]
    public async Task Cadastra_entra_ve_quem_e_e_sai()
    {
        var reg = await _c.PostAsync("/operator/auth/register", Account("Maria.Silva"));
        Assert.Equal(HttpStatusCode.Created, reg.StatusCode);
        Assert.Equal("maria.silva", (string)(await reg.Obj())["login"]!);

        var login = await _c.PostAsync("/operator/auth/login", Credentials("maria.silva"));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var body = await login.Obj();
        var token = (string)body["token"]!;
        Assert.Equal("Maria Silva", (string)body["name"]!);
        Assert.DoesNotContain("password", body.ToJsonString());

        var me = new HttpRequestMessage(HttpMethod.Get, "/operator/auth/me");
        me.Headers.Add("X-Session-Token", token);
        Assert.Equal("Maria Silva", (string)(await (await _c.SendAsync(me)).Obj())["name"]!);

        var list = new HttpRequestMessage(HttpMethod.Get, "/operator/records");
        list.Headers.Add("X-Session-Token", token);
        Assert.Equal(HttpStatusCode.OK, (await _c.SendAsync(list)).StatusCode);

        var logout = new HttpRequestMessage(HttpMethod.Post, "/operator/auth/logout");
        logout.Headers.Add("X-Session-Token", token);
        Assert.Equal(HttpStatusCode.NoContent, (await _c.SendAsync(logout)).StatusCode);
        var after = new HttpRequestMessage(HttpMethod.Get, "/operator/records");
        after.Headers.Add("X-Session-Token", token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _c.SendAsync(after)).StatusCode);
    }

    [Fact]
    public async Task Senha_errada_e_usuario_inexistente_respondem_401_igual()
    {
        await _c.PostAsync("/operator/auth/register", Account("joao"));
        var wrong = await _c.PostAsync("/operator/auth/login", Credentials("joao", "outra-senha"));
        var missing = await _c.PostAsync("/operator/auth/login", Credentials("ninguem"));
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
        Assert.Equal((string)(await wrong.Obj())["message"]!, (string)(await missing.Obj())["message"]!);
    }

    [Fact]
    public async Task Cadastro_recusa_usuario_repetido_e_dados_invalidos()
    {
        Assert.Equal(HttpStatusCode.Created, (await _c.PostAsync("/operator/auth/register", Account("ana"))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await _c.PostAsync("/operator/auth/register", Account("ANA"))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await _c.PostAsync("/operator/auth/register", Account("a b"))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await _c.PostAsync("/operator/auth/register", Account("bia", password: "curta"))).StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await _c.PostAsync("/operator/auth/register", Account("bia", name: " "))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await _c.PostAsync("/operator/auth/register", Api.Json("{"))).StatusCode);
    }

    [Fact]
    public async Task Com_convite_definido_cadastro_sem_o_codigo_certo_responde_403()
    {
        using var f = new SystemBFactory { Settings = { ["B_OPERATOR_INVITE_CODE"] = "convite-secreto" } };
        var c = f.CreateClient();
        StringContent WithInvite(string login, string? invite) => Api.Json(new JsonObject
        {
            ["login"] = login, ["name"] = "Maria", ["password"] = "senha-forte-1", ["inviteCode"] = invite,
        }.ToJsonString());

        Assert.Equal(HttpStatusCode.Forbidden, (await c.PostAsync("/operator/auth/register", Account("sem-convite"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await c.PostAsync("/operator/auth/register", WithInvite("errado", "outro"))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await c.PostAsync("/operator/auth/register", WithInvite("certo", "convite-secreto"))).StatusCode);
    }

    [Fact]
    public async Task Sessao_expira_depois_de_12_horas()
    {
        await _c.PostAsync("/operator/auth/register", Account("lia"));
        var token = (string)(await (await _c.PostAsync("/operator/auth/login", Credentials("lia"))).Obj())["token"]!;
        HttpRequestMessage Me()
        {
            var m = new HttpRequestMessage(HttpMethod.Get, "/operator/auth/me");
            m.Headers.Add("X-Session-Token", token);
            return m;
        }

        _f.Clock.Advance(TimeSpan.FromHours(11));
        Assert.Equal(HttpStatusCode.OK, (await _c.SendAsync(Me())).StatusCode);
        _f.Clock.Advance(TimeSpan.FromHours(1));
        Assert.Equal(HttpStatusCode.Unauthorized, (await _c.SendAsync(Me())).StatusCode);
    }

    [Fact]
    public async Task Login_errado_demais_responde_429_ate_a_janela_passar()
    {
        await _c.PostAsync("/operator/auth/register", Account("rui"));
        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await _c.PostAsync("/operator/auth/login", Credentials("rui", "senha-errada"))).StatusCode);
        // Bloqueado mesmo com a senha certa; outro usuário do mesmo endereço não é afetado
        Assert.Equal((HttpStatusCode)429, (await _c.PostAsync("/operator/auth/login", Credentials("rui"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _c.PostAsync("/operator/auth/login", Credentials("outra"))).StatusCode);

        _f.Clock.Advance(TimeSpan.FromMinutes(16));
        Assert.Equal(HttpStatusCode.OK, (await _c.PostAsync("/operator/auth/login", Credentials("rui"))).StatusCode);
    }

    [Fact]
    public void Senha_guardada_com_PBKDF2_e_salt_proprio()
    {
        var a = SystemB.Api.Storage.SqliteOperatorStore.HashPassword("senha-forte-1");
        var b = SystemB.Api.Storage.SqliteOperatorStore.HashPassword("senha-forte-1");
        Assert.StartsWith("pbkdf2$", a);
        Assert.NotEqual(a, b);
        Assert.True(SystemB.Api.Storage.SqliteOperatorStore.VerifyPassword("senha-forte-1", a));
        Assert.False(SystemB.Api.Storage.SqliteOperatorStore.VerifyPassword("senha-forte-2", a));
    }
}
