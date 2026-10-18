using System.Net;

namespace SystemB.Tests;

public class OperatorDeleteTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public OperatorDeleteTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    [Fact]
    public async Task Operador_exclui_e_a_leitura_passa_a_responder_404()
    {
        var keep = await _c.CreateId();
        var id = await _c.CreateId();

        Assert.Equal(HttpStatusCode.NoContent, (await _c.DeleteAsync($"/operator/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.GetAsync($"/api/v2/records/{id}")).StatusCode);

        var page = await (await _c.GetAsync("/api/v2/records")).Obj();
        Assert.Equal(1, (int)page["total"]!);
        Assert.Equal(keep, (string)page["items"]![0]!["id"]!);
    }

    [Fact]
    public async Task Excluir_duas_vezes_ou_id_inexistente_responde_404()
    {
        var id = await _c.CreateId();
        await _c.DeleteAsync($"/operator/records/{id}");
        Assert.Equal(HttpStatusCode.NotFound, (await _c.DeleteAsync($"/operator/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.DeleteAsync("/operator/records/B-424242")).StatusCode);
    }

    [Fact]
    public async Task Put_em_registro_excluido_responde_404_o_B_nao_ressuscita_sozinho()
    {
        var id = await _c.CreateId();
        await _c.DeleteAsync($"/operator/records/{id}");
        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body()));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task A_API_do_sync_nao_tem_DELETE()
    {
        var id = await _c.CreateId();
        var res = await _c.DeleteAsync($"/api/v2/records/{id}");
        Assert.True(res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed, res.StatusCode.ToString());
        Assert.Equal(HttpStatusCode.OK, (await _c.GetAsync($"/api/v2/records/{id}")).StatusCode);
    }
}
