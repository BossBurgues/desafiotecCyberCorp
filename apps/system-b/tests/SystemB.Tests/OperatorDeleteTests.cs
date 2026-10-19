using System.Net;
using System.Net.Http.Json;

namespace SystemB.Tests;

/// <summary>Exclusão com lápide (ADR-015): pelo operador ou pela API do sync, o registro some e responde 410 com quem e quando.</summary>
public class OperatorDeleteTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public OperatorDeleteTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    [Fact]
    public async Task Operador_exclui_e_a_leitura_passa_a_responder_410_com_quem_excluiu()
    {
        var keep = await _c.CreateId();
        var id = await _c.CreateId();

        var del = new HttpRequestMessage(HttpMethod.Delete, $"/operator/records/{id}");
        del.Headers.Add("X-Operator", "Maria");
        Assert.Equal(HttpStatusCode.NoContent, (await _c.SendAsync(del)).StatusCode);

        var res = await _c.GetAsync($"/api/v2/records/{id}");
        Assert.Equal(HttpStatusCode.Gone, res.StatusCode);
        var body = await res.Obj();
        Assert.Equal("GONE", (string)body["error"]!);
        Assert.Equal("Maria", (string)body["deletedBy"]!);
        Assert.False(string.IsNullOrEmpty((string?)body["deletedAt"]));

        var page = await (await _c.GetAsync("/api/v2/records")).Obj();
        Assert.Equal(1, (int)page["total"]!);
        Assert.Equal(keep, (string)page["items"]![0]!["id"]!);
    }

    [Fact]
    public async Task Excluir_de_novo_responde_410_e_id_inexistente_404()
    {
        var id = await _c.CreateId();
        await _c.DeleteAsync($"/operator/records/{id}");
        Assert.Equal(HttpStatusCode.Gone, (await _c.DeleteAsync($"/operator/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _c.DeleteAsync("/operator/records/B-424242")).StatusCode);
    }

    [Fact]
    public async Task Put_em_registro_excluido_responde_410_o_B_nao_ressuscita_sozinho()
    {
        var id = await _c.CreateId();
        await _c.DeleteAsync($"/operator/records/{id}");
        var res = await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body()));
        Assert.Equal(HttpStatusCode.Gone, res.StatusCode);
    }

    [Fact]
    public async Task A_API_do_sync_exclui_com_lapide_da_integracao()
    {
        var id = await _c.CreateId();
        Assert.Equal(HttpStatusCode.NoContent, (await _c.DeleteAsync($"/api/v2/records/{id}")).StatusCode);
        var res = await _c.GetAsync($"/api/v2/records/{id}");
        Assert.Equal(HttpStatusCode.Gone, res.StatusCode);
        Assert.Equal("integração (sync)", (string)(await res.Obj())["deletedBy"]!);
        Assert.Equal(HttpStatusCode.Gone, (await _c.DeleteAsync($"/api/v2/records/{id}")).StatusCode);
    }
}
