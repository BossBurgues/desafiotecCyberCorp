using System.Globalization;

namespace SystemB.Api.Chaos;

/// <summary>
/// Configuração do caos. As taxas de falha são mutuamente exclusivas (um sorteio por requisição),
/// por isso a soma delas não pode passar de 1.
/// </summary>
public record ChaosOptions
{
    public int? Seed { get; init; }
    public int LatencyMs { get; init; }
    public double ErrorRate { get; init; }
    public double TimeoutRate { get; init; }
    public int TimeoutMs { get; init; } = 30_000;
    public double CommitThenFailRate { get; init; }
    public double AckWithoutPersistRate { get; init; }
    public double OkWithErrorBodyRate { get; init; }
    public double RateLimitRate { get; init; }
    public int TruncateText { get; init; }
    public double PageRepeatRate { get; init; }
    public double PageSkipRate { get; init; }
    public int ListDelayMs { get; init; }
    /// <summary>Drift de formato: as respostas de /api/v2/records trocam o nome de <c>title</c> para <c>summary</c> (cenário E1).</summary>
    public bool FormatDrift { get; init; }

    private const int MaxDelayMs = 600_000;

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();
        void Rate(string name, double v)
        {
            if (double.IsNaN(v) || v < 0 || v > 1) problems.Add($"{name} deve estar entre 0 e 1");
        }
        void Ms(string name, int v)
        {
            if (v < 0 || v > MaxDelayMs) problems.Add($"{name} deve estar entre 0 e {MaxDelayMs}");
        }

        Rate("errorRate", ErrorRate);
        Rate("timeoutRate", TimeoutRate);
        Rate("commitThenFailRate", CommitThenFailRate);
        Rate("ackWithoutPersistRate", AckWithoutPersistRate);
        Rate("okWithErrorBodyRate", OkWithErrorBodyRate);
        Rate("rateLimitRate", RateLimitRate);
        Rate("pageRepeatRate", PageRepeatRate);
        Rate("pageSkipRate", PageSkipRate);
        Ms("latencyMs", LatencyMs);
        Ms("timeoutMs", TimeoutMs);
        Ms("listDelayMs", ListDelayMs);
        if (TruncateText < 0) problems.Add("truncateText deve ser >= 0 (0 desliga)");

        var faults = ErrorRate + TimeoutRate + CommitThenFailRate + AckWithoutPersistRate + OkWithErrorBodyRate + RateLimitRate;
        if (faults > 1 + 1e-9) problems.Add("a soma das taxas de falha não pode passar de 1");
        if (PageRepeatRate + PageSkipRate > 1 + 1e-9) problems.Add("pageRepeatRate + pageSkipRate não pode passar de 1");
        return problems;
    }

    /// <summary>Lê as variáveis B_CHAOS_*; valor inválido derruba a inicialização (falha rápido).</summary>
    public static ChaosOptions FromConfiguration(IConfiguration c)
    {
        int? Int(string key)
        {
            var raw = c[$"B_CHAOS_{key}"];
            if (string.IsNullOrWhiteSpace(raw)) return null;
            return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v)
                ? v
                : throw new InvalidOperationException($"B_CHAOS_{key} deve ser um inteiro (recebido: {raw})");
        }
        bool Bool(string key)
        {
            var raw = c[$"B_CHAOS_{key}"];
            if (string.IsNullOrWhiteSpace(raw)) return false;
            return bool.TryParse(raw, out var v)
                ? v
                : throw new InvalidOperationException($"B_CHAOS_{key} deve ser true ou false (recebido: {raw})");
        }
        double Dbl(string key)
        {
            var raw = c[$"B_CHAOS_{key}"];
            if (string.IsNullOrWhiteSpace(raw)) return 0;
            return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
                ? v
                : throw new InvalidOperationException($"B_CHAOS_{key} deve ser um número (recebido: {raw})");
        }

        var options = new ChaosOptions
        {
            Seed = Int("SEED"),
            LatencyMs = Int("LATENCY_MS") ?? 0,
            ErrorRate = Dbl("ERROR_RATE"),
            TimeoutRate = Dbl("TIMEOUT_RATE"),
            TimeoutMs = Int("TIMEOUT_MS") ?? 30_000,
            CommitThenFailRate = Dbl("COMMIT_THEN_FAIL_RATE"),
            AckWithoutPersistRate = Dbl("ACK_WITHOUT_PERSIST_RATE"),
            OkWithErrorBodyRate = Dbl("OK_WITH_ERROR_BODY_RATE"),
            RateLimitRate = Dbl("RATE_LIMIT_RATE"),
            TruncateText = Int("TRUNCATE_TEXT") ?? 0,
            PageRepeatRate = Dbl("PAGE_REPEAT_RATE"),
            PageSkipRate = Dbl("PAGE_SKIP_RATE"),
            ListDelayMs = Int("LIST_DELAY_MS") ?? 0,
            FormatDrift = Bool("FORMAT_DRIFT"),
        };
        var problems = options.Validate();
        return problems.Count == 0
            ? options
            : throw new InvalidOperationException("Configuração de caos inválida: " + string.Join("; ", problems));
    }
}
