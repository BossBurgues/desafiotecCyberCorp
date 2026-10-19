using SystemB.Api.Models;

namespace SystemB.Api.Endpoints;

public static class ErrorResults
{
    private static IResult Json(int status, string code, string message) =>
        Results.Json(new ApiError(code, message), JsonDefaults.Options, statusCode: status);

    public static IResult BadRequest(string message) => Json(400, ApiError.BadRequest, message);
    public static IResult Validation(IEnumerable<string> problems) => Json(422, ApiError.ValidationError, string.Join("; ", problems));
    public static IResult NotFound(string message) => Json(404, ApiError.NotFound, message);

    public static IResult Gone(string id, Tombstone t) =>
        Results.Json(new GoneError(ApiError.Gone, $"Registro {id} foi excluído", t.DeletedBy, t.DeletedAt), JsonDefaults.Options, statusCode: 410);

    /// <summary>Registro ausente: 410 se tem lápide (excluído), 404 se nunca existiu.</summary>
    public static IResult Missing(string id, Storage.IRecordStore store) =>
        store.GetTombstone(id) is { } t ? Gone(id, t) : NotFound($"Registro {id} não encontrado");
}
