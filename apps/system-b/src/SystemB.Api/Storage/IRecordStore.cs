using SystemB.Api.Models;

namespace SystemB.Api.Storage;

public interface IRecordStore
{
    Models.Record Create(RecordInput input, string now);
    Models.Record? Get(string id);
    Models.Record? Replace(string id, RecordInput input, string now);
    IReadOnlyList<Models.Record> List(int offset, int limit);
    int Count();
    bool Delete(string id);
}
