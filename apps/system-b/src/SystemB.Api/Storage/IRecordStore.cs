using SystemB.Api.Models;

namespace SystemB.Api.Storage;

public interface IRecordStore
{
    Models.Record Create(RecordInput input, string now);
    Models.Record? Get(string id);
    Models.Record? Replace(string id, RecordInput input, string now);
    /// <param name="createdAtOrBefore">Só registros criados até este instante (atraso de listagem do caos); null = todos.</param>
    IReadOnlyList<Models.Record> List(int offset, int limit, string? createdAtOrBefore = null);
    int Count(string? createdAtOrBefore = null);
    bool Delete(string id);
    /// <summary>Apaga todos os registros. Os IDs não voltam a ser usados (AUTOINCREMENT): um ID antigo nunca aponta para outro registro.</summary>
    int Wipe();
}
