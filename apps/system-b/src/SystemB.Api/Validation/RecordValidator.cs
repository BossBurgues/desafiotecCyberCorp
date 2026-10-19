using System.Text.RegularExpressions;
using SystemB.Api.Models;

namespace SystemB.Api.Validation;

public static partial class RecordValidator
{
    public const int TitleMaxLength = 200;
    public const int ResolutionMaxLength = 2000;

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Pattern();

    /// <summary>Regras de domínio (422). Devolve o input com o título aparado; a lista vazia significa válido.</summary>
    public static (RecordInput Input, List<string> Errors) Validate(RecordInput input)
    {
        var errors = new List<string>();
        var title = input.Title?.Trim() ?? "";

        if (title.Length == 0) errors.Add("title é obrigatório e não pode ser vazio");
        else if (title.Length > TitleMaxLength) errors.Add($"title excede {TitleMaxLength} caracteres");

        if (input.Description is null) errors.Add("description é obrigatório");
        if (input.Resolution is { Length: > ResolutionMaxLength }) errors.Add($"resolution excede {ResolutionMaxLength} caracteres");

        if (input.Location is { } loc)
        {
            if (loc.Lat is < -90 or > 90) errors.Add("location.lat deve estar entre -90 e 90");
            if (loc.Lng is < -180 or > 180) errors.Add("location.lng deve estar entre -180 e 180");
        }

        for (var n = 0; n < input.Attachments.Count; n++)
        {
            var a = input.Attachments[n];
            if (a is null) { errors.Add($"attachments[{n}] não pode ser nulo"); continue; }
            if (a.Name is null) errors.Add($"attachments[{n}].name é obrigatório");
            if (a.Size < 0) errors.Add($"attachments[{n}].size não pode ser negativo");
            if (a.Sha256 is null || !Sha256Pattern().IsMatch(a.Sha256))
                errors.Add($"attachments[{n}].sha256 deve ter 64 caracteres hexadecimais minúsculos");
        }

        return (input with { Title = title }, errors);
    }
}
