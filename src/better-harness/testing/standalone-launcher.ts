import { EventEmitter } from "events";
export interface StandaloneHarnessOptions {
  projectPath?: string;
  serverKey?: string;
  projectKey?: string;
}
export interface StandaloneServerMeta {
  baseUrl: string;
  serverKey: string;
  projectKey: string;
  projectId: string;
  projectDir: string;
  stateDir: string;
  eventLogDir: string;
  port: number;
  stop: () => Promise<void>;
  shutdown: () => Promise<void>;
  eventBus: any;
}
export async function startStandaloneTestHarness(options?: StandaloneHarnessOptions): Promise<StandaloneServerMeta> {
  return {
    baseUrl: 'http://127.0.0.1:0',
    serverKey: options?.serverKey ?? '',
    projectKey: options?.projectKey ?? '',
    projectId: 'test-project',
    projectDir: options?.projectPath ?? '',
    stateDir: '',
    eventLogDir: '',
    port: 0,
    stop: async () => {},
    shutdown: async () => {},
    eventBus: new EventEmitter()
  };
}
export async function launchStandaloneServer(options?: StandaloneHarnessOptions): Promise<StandaloneServerMeta> {
  return startStandaloneTestHarness(options);
}
