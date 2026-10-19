# syntax=docker/dockerfile:1
# Contexto de build: apps/system-b (a .dockerignore da raiz exclui o B).
#   docker build -t system-b apps/system-b
#   docker buildx build --platform linux/amd64,linux/arm64 apps/system-b
ARG DOTNET_VERSION=8.0

# O SDK roda na arquitetura de quem compila e publica para a de destino: o arm64 não passa por emulação
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
ARG TARGETARCH
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY src/SystemB.Api/SystemB.Api.csproj src/SystemB.Api/
RUN dotnet restore src/SystemB.Api/SystemB.Api.csproj -a $TARGETARCH
COPY src/SystemB.Api/ src/SystemB.Api/
RUN dotnet publish src/SystemB.Api/SystemB.Api.csproj -c Release -a $TARGETARCH --no-restore -o /out \
    && mkdir -p /data

# Sem RUN no estágio final: nada executa na arquitetura de destino durante o build
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
ENV ASPNETCORE_URLS=http://0.0.0.0:5002 B_DB_PATH=/data/system-b.db DOTNET_NOLOGO=1
WORKDIR /app
COPY --from=build /out ./
# APP_UID (1654) é o usuário sem privilégios das imagens oficiais do .NET 8
COPY --from=build --chown=$APP_UID /data /data
VOLUME /data
USER $APP_UID
EXPOSE 5002
# A imagem aspnet não tem curl: o próprio binário faz a checagem (modo --healthcheck do Program.cs)
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["dotnet", "SystemB.Api.dll", "--healthcheck"]
ENTRYPOINT ["dotnet", "SystemB.Api.dll"]
