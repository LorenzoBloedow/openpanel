/** The part of a Cloudflare Queues `Message` the consumers use. */
export interface QueueMessage {
  body: unknown;
  id: string;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
