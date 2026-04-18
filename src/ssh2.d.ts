declare module "ssh2" {
  export class Client {
    public on(event: string, listener: (...args: any[]) => void): this;
    public connect(config: Record<string, unknown>): this;
    public exec(
      command: string,
      callback: (error: Error | undefined, stream: any) => void
    ): void;
    public end(): void;
  }
}
