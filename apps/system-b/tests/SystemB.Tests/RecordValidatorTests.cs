using SystemB.Api.Models;
using SystemB.Api.Validation;

namespace SystemB.Tests;

public class RecordValidatorTests
{
    private static RecordInput Valid() => new()
    {
        Title = "abc", Description = "d", State = State.OPEN, Severity = Severity.LOW,
    };

    [Fact]
    public void Title_e_aparado()
    {
        var (input, errors) = RecordValidator.Validate(Valid() with { Title = "  abc  " });
        Assert.Empty(errors);
        Assert.Equal("abc", input.Title);
    }

    [Fact]
    public void Title_so_com_espacos_e_erro() =>
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Title = "   " }).Errors);

    [Fact]
    public void Title_com_200_caracteres_passa_e_com_201_falha()
    {
        Assert.Empty(RecordValidator.Validate(Valid() with { Title = new string('a', 200) }).Errors);
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Title = new string('a', 201) }).Errors);
    }

    [Fact]
    public void Lat_e_lng_fora_da_faixa_falham()
    {
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Location = new() { Lat = 91 } }).Errors);
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Location = new() { Lng = -181 } }).Errors);
        Assert.Empty(RecordValidator.Validate(Valid() with { Location = new() { Lat = -90, Lng = 180 } }).Errors);
    }

    [Fact]
    public void Anexo_com_sha256_maiusculo_ou_size_negativo_falha()
    {
        var upper = new Attachment { Name = "a", Size = 1, Sha256 = new string('A', 64) };
        var neg = new Attachment { Name = "a", Size = -1, Sha256 = new string('a', 64) };
        var ok = new Attachment { Name = "a", Size = 0, Sha256 = new string('a', 64) };
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Attachments = [upper] }).Errors);
        Assert.NotEmpty(RecordValidator.Validate(Valid() with { Attachments = [neg] }).Errors);
        Assert.Empty(RecordValidator.Validate(Valid() with { Attachments = [ok] }).Errors);
    }

    [Fact]
    public void Description_com_marcador_e_quebras_passa_intacta()
    {
        var text = "  texto\n\n⟦s:glpi-42⟧ ";
        var (input, errors) = RecordValidator.Validate(Valid() with { Description = text });
        Assert.Empty(errors);
        Assert.Equal(text, input.Description);
    }
}

public class JsonFormatTests
{
    private static RecordInput? Parse(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<RecordInput>(json, JsonDefaults.Options);

    [Fact]
    public void Enums_sao_strings_e_campos_desconhecidos_sao_rejeitados()
    {
        var ok = Parse("""{"title":"t","description":"d","state":"IN_PROGRESS","severity":"HIGH"}""");
        Assert.Equal(State.IN_PROGRESS, ok!.State);
        Assert.Throws<System.Text.Json.JsonException>(() =>
            Parse("""{"title":"t","description":"d","state":"DONE","severity":"HIGH"}"""));
        Assert.Throws<System.Text.Json.JsonException>(() =>
            Parse("""{"title":"t","description":"d","state":1,"severity":"HIGH"}"""));
        Assert.Throws<System.Text.Json.JsonException>(() =>
            Parse("""{"id":"B-1","title":"t","description":"d","state":"OPEN","severity":"HIGH"}"""));
    }

    [Fact]
    public void Saida_usa_camelCase_e_escreve_null()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(
            SystemB.Api.Models.Record.From("B-1", Parse("""{"title":"t","description":"d","state":"OPEN","severity":"LOW"}""")!, "c", "u"),
            JsonDefaults.Options);
        Assert.Contains("\"sourceUpdatedAt\":null", json);
        Assert.Contains("\"createdAt\":\"c\"", json);
        Assert.Contains("\"state\":\"OPEN\"", json);
    }
}
