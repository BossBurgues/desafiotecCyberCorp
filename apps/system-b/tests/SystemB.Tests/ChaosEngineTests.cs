using Microsoft.Extensions.Configuration;
using SystemB.Api.Chaos;

namespace SystemB.Tests;

public class ChaosEngineTests
{
    private static ChaosOptions Mixed(int? seed) => new()
    {
        Seed = seed, ErrorRate = 0.2, TimeoutRate = 0.1, RateLimitRate = 0.1,
        AckWithoutPersistRate = 0.1, CommitThenFailRate = 0.1, OkWithErrorBodyRate = 0.1,
        PageRepeatRate = 0.3, PageSkipRate = 0.3,
    };

    private static List<string> Run(ChaosEngine e, int n) =>
        Enumerable.Range(0, n).Select(i => $"{e.Decide(i % 2 == 0)}/{e.PageShift()}").ToList();

    [Fact]
    public void Mesma_seed_produz_a_mesma_sequencia_de_falhas()
    {
        Assert.Equal(Run(new ChaosEngine(Mixed(42)), 200), Run(new ChaosEngine(Mixed(42)), 200));
        Assert.NotEqual(Run(new ChaosEngine(Mixed(42)), 200), Run(new ChaosEngine(Mixed(7)), 200));
    }

    [Fact]
    public void Configurar_de_novo_com_a_mesma_seed_recomeca_a_sequencia()
    {
        var e = new ChaosEngine(Mixed(42));
        var first = Run(e, 50);
        e.Configure(Mixed(42));
        Assert.Equal(first, Run(e, 50));
        e.Reset();
        Assert.Equal(first, Run(e, 50));
    }

    [Fact]
    public void Sem_taxas_nunca_ha_falha()
    {
        var e = new ChaosEngine(new ChaosOptions { Seed = 1 });
        Assert.All(Enumerable.Range(0, 500), _ => Assert.Equal(Fault.None, e.Decide(true)));
        Assert.All(Enumerable.Range(0, 500), _ => Assert.Equal(0, e.PageShift()));
    }

    [Fact]
    public void Taxa_1_sempre_dispara_a_falha()
    {
        var e = new ChaosEngine(new ChaosOptions { Seed = 1, ErrorRate = 1 });
        Assert.All(Enumerable.Range(0, 200), _ => Assert.Equal(Fault.Error, e.Decide(false)));
    }

    [Fact]
    public void Falhas_de_escrita_nao_se_aplicam_a_leituras()
    {
        var e = new ChaosEngine(new ChaosOptions { Seed = 1, AckWithoutPersistRate = 0.5, CommitThenFailRate = 0.5 });
        Assert.All(Enumerable.Range(0, 200), _ => Assert.Equal(Fault.None, e.Decide(isWrite: false)));
        Assert.All(Enumerable.Range(0, 200), _ =>
            Assert.Contains(e.Decide(isWrite: true), new[] { Fault.AckWithoutPersist, Fault.CommitThenFail }));
    }

    [Fact]
    public void A_frequencia_observada_acompanha_a_taxa()
    {
        var e = new ChaosEngine(new ChaosOptions { Seed = 123, ErrorRate = 0.3 });
        var errors = Enumerable.Range(0, 10_000).Count(_ => e.Decide(true) == Fault.Error);
        Assert.InRange(errors, 2_800, 3_200);
    }

    [Theory]
    [InlineData(1.5, 0, 0)]
    [InlineData(-0.1, 0, 0)]
    [InlineData(0.6, 0.6, 0)]
    [InlineData(0, 0, -1)]
    public void Configuracao_invalida_e_rejeitada(double errorRate, double timeoutRate, int latencyMs)
    {
        var o = new ChaosOptions { ErrorRate = errorRate, TimeoutRate = timeoutRate, LatencyMs = latencyMs };
        Assert.NotEmpty(o.Validate());
    }

    [Fact]
    public void Variaveis_de_ambiente_invalidas_derrubam_a_inicializacao()
    {
        IConfiguration Cfg(string k, string v) => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [k] = v }).Build();

        Assert.Throws<InvalidOperationException>(() => ChaosOptions.FromConfiguration(Cfg("B_CHAOS_ERROR_RATE", "muito")));
        Assert.Throws<InvalidOperationException>(() => ChaosOptions.FromConfiguration(Cfg("B_CHAOS_LATENCY_MS", "1.5")));
        Assert.Throws<InvalidOperationException>(() => ChaosOptions.FromConfiguration(Cfg("B_CHAOS_ERROR_RATE", "2")));
        Assert.Equal(0.25, ChaosOptions.FromConfiguration(Cfg("B_CHAOS_ERROR_RATE", "0.25")).ErrorRate);
        Assert.Throws<InvalidOperationException>(() => ChaosOptions.FromConfiguration(Cfg("B_CHAOS_FORMAT_DRIFT", "talvez")));
        Assert.True(ChaosOptions.FromConfiguration(Cfg("B_CHAOS_FORMAT_DRIFT", "true")).FormatDrift);
    }
}
