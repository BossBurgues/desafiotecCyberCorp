using Microsoft.Data.Sqlite;
using SystemB.Api.Models;
using SystemB.Api.Storage;

namespace SystemB.Tests;

public class SqliteRecordStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"systemb-{Guid.NewGuid():N}.db");

    private static RecordInput Input(string title = "t") => new()
    {
        Title = title, Description = "d\n\n⟦s:glpi-42⟧", State = State.OPEN, Severity = Severity.LOW,
    };

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { File.Delete(_path); } catch (IOException) { }
    }

    [Fact]
    public void Dados_sobrevivem_a_reabrir_o_arquivo()
    {
        var first = new SqliteRecordStore(_path).Create(Input(), "2026-10-18T10:00:00.000Z");
        SqliteConnection.ClearAllPools();

        var reopened = new SqliteRecordStore(_path).Get(first.Id);
        Assert.NotNull(reopened);
        Assert.Equal("d\n\n⟦s:glpi-42⟧", reopened.Description);
        Assert.Equal("2026-10-18T10:00:00.000Z", reopened.CreatedAt);
    }

    [Fact]
    public void Ids_saem_em_sequencia_e_nao_sao_reaproveitados_apos_delete()
    {
        var store = new SqliteRecordStore(_path);
        var a = store.Create(Input("a"), "n");
        var b = store.Create(Input("b"), "n");
        Assert.Equal("B-1", a.Id);
        Assert.Equal("B-2", b.Id);

        Assert.True(store.Delete(b.Id));
        Assert.Equal("B-3", store.Create(Input("c"), "n").Id);
        Assert.False(store.Delete(b.Id));
    }

    [Fact]
    public void Replace_preserva_createdAt_e_devolve_null_se_nao_existe()
    {
        var store = new SqliteRecordStore(_path);
        var a = store.Create(Input("a"), "t1");
        var replaced = store.Replace(a.Id, Input("novo"), "t2");
        Assert.Equal("novo", replaced!.Title);
        Assert.Equal("t1", replaced.CreatedAt);
        Assert.Equal("t2", replaced.UpdatedAt);
        Assert.Null(store.Replace("B-999", Input(), "t2"));
    }

    [Fact]
    public void List_segue_a_ordem_de_insercao_e_Count_confere()
    {
        var store = new SqliteRecordStore(_path);
        for (var i = 1; i <= 5; i++) store.Create(Input($"r{i}"), "n");
        Assert.Equal(5, store.Count());
        Assert.Equal(["r2", "r3"], store.List(1, 2).Select(r => r.Title));
    }
}
