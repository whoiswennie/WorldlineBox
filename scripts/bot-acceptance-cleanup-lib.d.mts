export interface AcceptanceProcess { ProcessId: number; ParentProcessId?: number; CommandLine?: string }
export interface AcceptanceRootProof { path: string; owner?: string; rootReparse?: boolean; nestedLinks?: number; files?: number; alivePids?: number[]; alreadyRemoved?: boolean }
export function acceptanceProcesses(): Promise<AcceptanceProcess[]>;
export function inspectAcceptanceRoot(root: string, processes: AcceptanceProcess[], allowedOwnerPid?: number): Promise<AcceptanceRootProof>;
export function removeAcceptanceRoot(root: string, allowedOwnerPid?: number): Promise<AcceptanceRootProof>;
