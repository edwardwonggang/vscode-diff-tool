export interface InteractionToken {
  requestId: number;
  sessionId: number;
}

export class InteractionController {
  private sessionId = 1;
  private latestDiffRequestId = 0;
  private latestRefreshRequestId = 0;

  public beginDiffRequest(): InteractionToken {
    this.latestDiffRequestId += 1;
    return {
      requestId: this.latestDiffRequestId,
      sessionId: this.sessionId
    };
  }

  public beginRefreshRequest(): InteractionToken {
    this.latestRefreshRequestId += 1;
    return {
      requestId: this.latestRefreshRequestId,
      sessionId: this.sessionId
    };
  }

  public isLatestDiffRequest(token: InteractionToken): boolean {
    return token.sessionId === this.sessionId && token.requestId === this.latestDiffRequestId;
  }

  public isLatestRefreshRequest(token: InteractionToken): boolean {
    return token.sessionId === this.sessionId && token.requestId === this.latestRefreshRequestId;
  }

  public resetSession(): void {
    this.sessionId += 1;
    this.latestDiffRequestId = 0;
    this.latestRefreshRequestId = 0;
  }

  public cancelDiffRequests(): void {
    this.latestDiffRequestId += 1;
  }

  public cancelRefreshRequests(): void {
    this.latestRefreshRequestId += 1;
  }
}
