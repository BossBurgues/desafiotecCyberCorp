export class MappingError extends Error {
  public readonly permanent = true as const;
  public readonly field: string;
  public readonly value: unknown;

  constructor(field: string, value: unknown, reason: string) {
    super(`Falha permanente ao mapear "${field}": ${reason}`);
    this.name = 'MappingError';
    this.field = field;
    this.value = value;
  }
}
