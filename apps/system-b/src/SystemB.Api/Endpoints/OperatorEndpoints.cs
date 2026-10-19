using SystemB.Api.Storage;

namespace SystemB.Api.Endpoints;

/// <summary>
/// Rotas do operador do B, usadas pela UI. Ficam fora de /api/v2 e do contrato de propósito: o sync não pode depender
/// delas (ADR-003, ADR-007) e o caos não as atinge, para a demo continuar operável. Sem papéis: o B é caixa-preta.
/// </summary>
public static class OperatorEndpoints
{
    public static void MapOperator(this WebApplication app)
    {
        var g = app.MapGroup("/operator/records");
        g.MapGet("/", RecordsEndpoints.List);
        g.MapGet("/{id}", RecordsEndpoints.Get);
        g.MapPut("/{id}", RecordsEndpoints.Put);
        // A exclusão do operador usa a mesma lápide da API: o sync vê o 410 com quem excluiu (ADR-015)
        g.MapDelete("/{id}", RecordsEndpoints.Delete);
    }
}
