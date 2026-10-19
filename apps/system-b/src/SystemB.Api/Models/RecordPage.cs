namespace SystemB.Api.Models;

public record RecordPage(IReadOnlyList<Record> Items, int Page, int PageSize, int Total);
