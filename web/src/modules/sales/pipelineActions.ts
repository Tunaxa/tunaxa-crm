export function pipelineMoveMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not move this deal. Please try again.";
}

export async function moveDealToStage(
  update: (id: string, data: { stage: string }) => Promise<unknown>,
  id: string,
  stage: string,
  reportError: (message: string) => void,
): Promise<boolean> {
  try {
    await update(id, { stage });
    return true;
  } catch (error) {
    const message = pipelineMoveMessage(error);
    reportError(message);
    return false;
  }
}
