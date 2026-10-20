namespace SystemB.Api.Models;

/// <summary>
/// Lápide de um registro excluído (capacidade opcional "tombstone", ADR-015). Distingue "excluído por alguém" (410, com
/// quem e quando) de "nunca existiu ou se perdeu" (404): o sync decide diferente em cada caso.
/// </summary>
public record Tombstone(string DeletedBy, string DeletedAt);

/// <summary>Corpo do 410: o erro de sempre mais a lápide.</summary>
public record GoneError(string Error, string Message, string DeletedBy, string DeletedAt);
