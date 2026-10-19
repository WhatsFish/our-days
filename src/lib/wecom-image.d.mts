export class WecomSendError extends Error {
  unknown: boolean;
  constructor(message: string, unknown?: boolean);
}
export function sendWecomImage(
  image: Buffer,
  config: { corpId: string | undefined; secret: string | undefined; agentId: number; userId: string | undefined },
  fetcher?: typeof fetch,
): Promise<{ status: "accepted"; msgid: string }>;
