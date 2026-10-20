using SystemB.Api.Models;

namespace SystemB.Api.Storage;

public interface IRecordStore
{
    Models.Record Create(RecordInput input, string now, string? updatedBy = null);
    Models.Record? Get(string id);
    Models.Record? Replace(string id, RecordInput input, string now, string? updatedBy = null);
    /// <param name="createdAtOrBefore">Só registros criados até este instante (atraso de listagem do caos); null = todos.</param>
    IReadOnlyList<Models.Record> List(int offset, int limit, string? createdAtOrBefore = null);
    int Count(string? createdAtOrBefore = null);
    /// <summary>Exclusão com lápide: o registro some da leitura e da listagem, e a lápide guarda quem e quando. false = não existe ou já excluído.</summary>
    bool Delete(string id, string now, string deletedBy);
    /// <summary>Apaga a linha de vez, sem lápide (perda de dados simulada pelo admin): a leitura passa a dar 404.</summary>
    bool Purge(string id);
    /// <summary>Lápide do registro excluído; null se ele existe ou nunca existiu.</summary>
    Tombstone? GetTombstone(string id);
    /// <summary>Apaga todos os registros. Os IDs não voltam a ser usados (AUTOINCREMENT): um ID antigo nunca aponta para outro registro.</summary>
    int Wipe();
}
