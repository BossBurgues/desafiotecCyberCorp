using System.Text.Json.Serialization;

namespace SystemB.Api.Models;

public enum State { OPEN, IN_PROGRESS, ON_HOLD, RESOLVED, CLOSED }

public enum Severity { LOW, MEDIUM, HIGH, CRITICAL }

public record Location
{
    public string? Name { get; init; }
    public double? Lat { get; init; }
    public double? Lng { get; init; }
}

public record Attachment
{
    public string? Name { get; init; }
    public long Size { get; init; }
    public string? Sha256 { get; init; }
}

/// <summary>Campos enviados pelo cliente (sem os readOnly: id, createdAt, updatedAt).</summary>
public record RecordInput
{
    public required string Title { get; init; }
    public required string Description { get; init; }
    public required State State { get; init; }
    public required Severity Severity { get; init; }
    public string? Category { get; init; }
    public string? Requester { get; init; }
    public string? Assignee { get; init; }
    public Location? Location { get; init; }
    public string? SourceUpdatedAt { get; init; }
    public List<Attachment> Attachments { get; init; } = [];
}

/// <summary>Registro como o B o devolve. Mesmos campos do RecordInput mais id e relógio do B.</summary>
public record Record
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Description { get; init; }
    public required State State { get; init; }
    public required Severity Severity { get; init; }
    public string? Category { get; init; }
    public string? Requester { get; init; }
    public string? Assignee { get; init; }
    public Location? Location { get; init; }
    public string? SourceUpdatedAt { get; init; }
    public List<Attachment> Attachments { get; init; } = [];
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }

    public static Record From(string id, RecordInput i, string createdAt, string updatedAt) => new()
    {
        Id = id, Title = i.Title, Description = i.Description, State = i.State, Severity = i.Severity,
        Category = i.Category, Requester = i.Requester, Assignee = i.Assignee, Location = i.Location,
        SourceUpdatedAt = i.SourceUpdatedAt, Attachments = i.Attachments, CreatedAt = createdAt, UpdatedAt = updatedAt,
    };
}
