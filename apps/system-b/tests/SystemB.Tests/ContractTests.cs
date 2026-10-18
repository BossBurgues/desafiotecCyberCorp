using System.Net;
using System.Text.Json.Nodes;
using Json.Schema;
using YamlDotNet.RepresentationModel;

namespace SystemB.Tests;

/// <summary>Confere as respostas do B com components.schemas de contracts/system-b.openapi.yaml.</summary>
public class ContractTests : IDisposable
{
    private readonly SystemBFactory _f = new();
    private readonly HttpClient _c;

    public ContractTests() => _c = _f.CreateClient();

    public void Dispose() => _f.Dispose();

    private static string FindContract()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "contracts", "system-b.openapi.yaml");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("contracts/system-b.openapi.yaml não encontrado acima do diretório de teste");
    }

    private static JsonNode YamlToJson(string yaml)
    {
        var stream = new YamlStream();
        stream.Load(new StringReader(yaml));
        return Convert(stream.Documents[0].RootNode)!;
    }

    // Escalares sem aspas viram bool/número/null; com aspas continuam texto (ex.: '^[0-9a-f]{64}$', 'null').
    private static JsonNode? Convert(YamlNode node) => node switch
    {
        YamlMappingNode m => new JsonObject(m.Children.Select(kv =>
            KeyValuePair.Create(((YamlScalarNode)kv.Key).Value!, Convert(kv.Value)))),
        YamlSequenceNode s => new JsonArray(s.Children.Select(Convert).ToArray()),
        YamlScalarNode { Style: YamlDotNet.Core.ScalarStyle.Plain } sc => sc.Value switch
        {
            "true" => JsonValue.Create(true),
            "false" => JsonValue.Create(false),
            "null" or "~" or null => null,
            var v when long.TryParse(v, System.Globalization.CultureInfo.InvariantCulture, out var l) => JsonValue.Create(l),
            var v when double.TryParse(v, System.Globalization.CultureInfo.InvariantCulture, out var d) => JsonValue.Create(d),
            var v => JsonValue.Create(v),
        },
        YamlScalarNode sc => JsonValue.Create(sc.Value),
        _ => throw new NotSupportedException(node.GetType().Name),
    };

    private static readonly JsonNode Document = YamlToJson(File.ReadAllText(FindContract()));

    private static void AssertMatches(string schemaName, JsonNode? instance)
    {
        var schema = new JsonObject
        {
            ["$schema"] = "https://json-schema.org/draft/2020-12/schema",
            ["components"] = Document["components"]!.DeepClone(),
            ["$ref"] = $"#/components/schemas/{schemaName}",
        };
        var result = JsonSchema.FromText(schema.ToJsonString())
            .Evaluate(instance, new EvaluationOptions { OutputFormat = OutputFormat.List });
        Assert.True(result.IsValid, $"{schemaName} não confere com o contrato: {instance?.ToJsonString()}");
    }

    [Fact]
    public async Task Respostas_de_POST_GET_e_PUT_conferem_com_Record()
    {
        var post = await _c.PostAsync("/api/v2/records", Api.Json(Api.Sample));
        var created = await post.Obj();
        AssertMatches("Record", created);
        var id = (string)created["id"]!;

        AssertMatches("Record", await (await _c.GetAsync($"/api/v2/records/{id}")).Obj());
        AssertMatches("Record", await (await _c.PutAsync($"/api/v2/records/{id}", Api.Json(Api.Body()))).Obj());
    }

    [Fact]
    public async Task Pagina_da_listagem_confere_com_RecordPage()
    {
        await _c.CreateId(Api.Sample);
        await _c.CreateId();
        AssertMatches("RecordPage", await (await _c.GetAsync("/api/v2/records?pageSize=1")).Obj());
    }

    [Fact]
    public async Task Corpos_de_400_404_e_422_conferem_com_Error()
    {
        var bad = await _c.PostAsync("/api/v2/records", Api.Json("{"));
        var missing = await _c.GetAsync("/api/v2/records/B-424242");
        var invalid = await _c.PostAsync("/api/v2/records", Api.Json(Api.Body(title: "")));

        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalid.StatusCode);
        foreach (var res in new[] { bad, missing, invalid }) AssertMatches("Error", await res.Obj());
    }

    [Fact]
    public void O_teste_de_contrato_detecta_um_registro_fora_do_schema()
    {
        var wrong = JsonNode.Parse("""{"id":"B-1","title":"t","description":"d","state":"DONE","severity":"LOW"}""");
        Assert.ThrowsAny<Exception>(() => AssertMatches("Record", wrong));
    }
}
