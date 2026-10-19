using SystemB.Api.Models;

namespace SystemB.Api.Endpoints;

public static class ErrorResults
{
    private static IResult Json(int status, string code, string message) =>
        Results.Json(new ApiError(code, message), JsonDefaults.Options, statusCode: status);

    public static IResult BadRequest(string message) => Json(400, ApiError.BadRequest, message);
    public static IResult Validation(IEnumerable<string> problems) => Json(422, ApiError.ValidationError, string.Join("; ", problems));
    public static IResult NotFound(string message) => Json(404, ApiError.NotFound, message);
}
