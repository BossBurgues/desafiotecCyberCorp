using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace SystemB.Tests;

/// <summary>Ajudantes de teste: corpos JSON e leitura de respostas.</summary>
public static class Api
{
    public const string Sample = """
        {"title":"Impressora do 3º andar não imprime",
         "description":"A impressora parou.\n\n⟦s:glpi-42⟧",
         "state":"IN_PROGRESS","severity":"HIGH",
         "category":"Hardware > Impressoras","requester":"maria@cybercorp.local","assignee":"tecnico@cybercorp.local",
         "location":{"name":"Matriz - 3º andar","lat":-23.5505,"lng":-46.6333},
         "sourceUpdatedAt":"2026-10-18T17:03:22Z","attachments":[]}
        """;

    public static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    public static string Body(string title = "t", string description = "d") =>
        new JsonObject { ["title"] = title, ["description"] = description, ["state"] = "OPEN", ["severity"] = "LOW" }.ToJsonString();

    public static async Task<JsonObject> Obj(this HttpResponseMessage res) =>
        (await res.Content.ReadFromJsonAsync<JsonObject>())!;

    public static async Task<string> CreateId(this HttpClient c, string? json = null)
    {
        var res = await c.PostAsync("/api/v2/records", Json(json ?? Body()));
        res.EnsureSuccessStatusCode();
        return (string)(await res.Obj())["id"]!;
    }
}
