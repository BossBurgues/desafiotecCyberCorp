using System.Security.Cryptography;
using System.Text;

namespace SystemB.Api.Endpoints;

public static class Secrets
{
    /// <summary>
    /// Compara um segredo (token de admin, código de convite) em tempo fixo. Os dois lados viram SHA-256 antes, então
    /// nem o tamanho do segredo vaza pelo tempo de resposta.
    /// </summary>
    public static bool Matches(string expected, string? given) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)),
            SHA256.HashData(Encoding.UTF8.GetBytes(given ?? "")));
}
