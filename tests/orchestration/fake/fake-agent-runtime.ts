export class FakeAgentRuntime {
  public executions: any[] = [];
  async execute(agentId: string, input: any): Promise<any> {
    this.executions.push({ agentId, input });
    return { status: 'success', output: 'fake output' };
  }
}
