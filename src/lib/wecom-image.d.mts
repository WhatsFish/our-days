export class WecomSendError extends Error {
  unknown: boolean;
  recipients?: WecomRecipientResult[];
  recordId?: string;
  constructor(message: string, unknown?: boolean, recipients?: WecomRecipientResult[], recordId?: string);
}
export type WecomRecipientResult = { userId: string; status: "accepted" | "failed" | "unknown" };
export function wecomRecipients(value: string | undefined): string[];
export function sendWecomImage(
  image: Buffer,
  config: { corpId: string | undefined; secret: string | undefined; agentId: number; userId: string | undefined },
  fetcher?: typeof fetch,
): Promise<{ status: "accepted"; msgid: string; recipients: WecomRecipientResult[] }>;
