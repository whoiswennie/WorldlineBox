/** Public identity of one ready Desktop runtime generation. */
export interface HostGeneration {
  readonly id: number
  readonly origin: string
}

/** Lifecycle authority shared by the Desktop runtime supervisor. */
export interface HostSupervisor {
  readonly current: HostGeneration | undefined
  start(): Promise<string>
  restart(reason: string, beforeStart?: () => Promise<void>): Promise<HostGeneration>
  shutdown(): Promise<void>
}
