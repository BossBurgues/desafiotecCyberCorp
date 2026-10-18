namespace SystemB.Api.Chaos;

public enum Fault { None, RateLimit, Error, Timeout, AckWithoutPersist, CommitThenFail, OkWithErrorBody }

/// <summary>
/// Sorteia as falhas. Com seed, a mesma sequência de requisições produz as mesmas decisões (reprodutível na CI e na demo).
/// </summary>
public sealed class ChaosEngine
{
    private readonly ChaosOptions _initial;
    private readonly object _lock = new();
    private ChaosOptions _options;
    private Random _rng;

    public ChaosEngine(ChaosOptions initial)
    {
        _initial = initial;
        _options = initial;
        _rng = NewRandom(initial.Seed);
    }

    private static Random NewRandom(int? seed) => seed is { } s ? new Random(s) : new Random();

    public ChaosOptions Options { get { lock (_lock) return _options; } }

    /// <summary>Troca a configuração e reinicia o gerador: a mesma seed recomeça a mesma sequência.</summary>
    public void Configure(ChaosOptions options)
    {
        lock (_lock)
        {
            _options = options;
            _rng = NewRandom(options.Seed);
        }
    }

    /// <summary>Volta para o que veio das variáveis de ambiente.</summary>
    public void Reset() => Configure(_initial);

    /// <summary>
    /// Um sorteio por requisição, percorrendo as faixas acumuladas. Falhas que só fazem sentido em escrita
    /// (ack sem gravar, grava e falha) viram "sem falha" numa leitura.
    /// </summary>
    public Fault Decide(bool isWrite)
    {
        lock (_lock)
        {
            var o = _options;
            var u = _rng.NextDouble();
            (Fault Fault, double Rate)[] bands =
            [
                (Fault.RateLimit, o.RateLimitRate),
                (Fault.Error, o.ErrorRate),
                (Fault.Timeout, o.TimeoutRate),
                (Fault.AckWithoutPersist, o.AckWithoutPersistRate),
                (Fault.CommitThenFail, o.CommitThenFailRate),
                (Fault.OkWithErrorBody, o.OkWithErrorBodyRate),
            ];
            var acc = 0.0;
            foreach (var (fault, rate) in bands)
            {
                acc += rate;
                if (u < acc)
                    return !isWrite && (fault is Fault.AckWithoutPersist or Fault.CommitThenFail) ? Fault.None : fault;
            }
            return Fault.None;
        }
    }

    /// <summary>Deslocamento do offset da listagem: -1 repete o último item da página anterior, +1 pula um item.</summary>
    public int PageShift()
    {
        lock (_lock)
        {
            var o = _options;
            if (o.PageRepeatRate == 0 && o.PageSkipRate == 0) return 0;
            var u = _rng.NextDouble();
            if (u < o.PageRepeatRate) return -1;
            return u < o.PageRepeatRate + o.PageSkipRate ? 1 : 0;
        }
    }

    public int Next(int minInclusive, int maxExclusive)
    {
        lock (_lock) return _rng.Next(minInclusive, maxExclusive);
    }
}
