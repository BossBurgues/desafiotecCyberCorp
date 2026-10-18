namespace SystemB.Api.Models;

public record ApiError(string Error, string Message)
{
    public const string BadRequest = "BAD_REQUEST";
    public const string ValidationError = "VALIDATION_ERROR";
    public const string NotFound = "NOT_FOUND";
    public const string Internal = "INTERNAL_ERROR";
}
