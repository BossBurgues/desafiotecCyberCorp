using SystemB.Api.Storage;

namespace SystemB.Api.Endpoints;

/// <summary>
/// Rotas do operador do B. Ficam fora de /api/v2 e do contrato de propósito: o sync não pode depender delas (ADR-003, ADR-007).
/// </summary>
public static class OperatorEndpoints
{
    public static void MapOperator(this WebApplication app)
    {
        app.MapDelete("/operator/records/{id}", (string id, IRecordStore store) =>
            store.Delete(id) ? Results.NoContent() : ErrorResults.NotFound($"Registro {id} não encontrado"));
    }
}
