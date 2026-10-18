using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SystemB.Api.Models;

public static class JsonDefaults
{
    /// <summary>camelCase, enums como string, campos desconhecidos rejeitados, null sempre escrito.</summary>
    public static JsonSerializerOptions Create() => new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Converters = { new JsonStringEnumConverter(namingPolicy: null, allowIntegerValues: false) },
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static readonly JsonSerializerOptions Options = Create();
}
