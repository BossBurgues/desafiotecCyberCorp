export type GlpiDateTime = string;

export type TicketStatus = 1 | 2 | 3 | 4 | 5 | 6;

export type TicketPriority = 1 | 2 | 3 | 4 | 5 | 6;

export interface TicketAttachment {
  name: string;
  size: number;
  sha256: string;
}

export interface GlpiTicket {
  id: number;
  name: string;
  content: string;
  status: TicketStatus;
  priority: TicketPriority;
  itilcategories_id?: number | null;
  locations_id?: number | null;
  users_id_recipient?: number | null;
  users_id_assign?: number | null;
  date: GlpiDateTime;
  date_mod: GlpiDateTime;
  solvedate?: GlpiDateTime | null;
  closedate?: GlpiDateTime | null;
  /** Lixeira do GLPI (ADR-015): 1 = excluído no A; no B, o registro é excluído. */
  is_deleted?: 0 | 1;
  attachments?: TicketAttachment[];
}

export type RecordState = 'OPEN' | 'IN_PROGRESS' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED';

export type RecordSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RecordLocation {
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface RecordAttachment {
  name: string;
  size: number;
  sha256: string;
}

export interface RecordInput {
  title: string;
  description: string;
  state: RecordState;
  severity: RecordSeverity;
  category?: string | null;
  requester?: string | null;
  assignee?: string | null;
  location?: RecordLocation | null;
  sourceUpdatedAt?: string | null;
  attachments?: RecordAttachment[];
  /** Texto da solução: campo do B (o operador escreve), preservado pelo sync ao atualizar o registro. Fora do hash. */
  resolution?: string | null;
}

export interface BRecord extends RecordInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string | null;
}

export type MarkerField = 'description' | 'title';

export interface Lookups {
  categories?: ReadonlyMap<number, string> | Readonly<Record<number, string>>;
  users?: ReadonlyMap<number, string> | Readonly<Record<number, string>>;
  locations?: ReadonlyMap<number, RecordLocation> | Readonly<Record<number, RecordLocation>>;
}

export interface MapTicketOptions {
  timeZone: string;
  markerField?: MarkerField;
  lookups?: Lookups;
}
