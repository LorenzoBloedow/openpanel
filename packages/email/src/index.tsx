import type { z } from 'zod';

import { db } from '@openpanel/db';
import { getEnv } from '@openpanel/runtime';
import { type TemplateKey, type Templates, templates } from './emails';
import { renderTemplate } from './render';
import { getUnsubscribeUrl } from './unsubscribe';

/** a***@example.com, enough to correlate a log line without exposing the address. */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${email[0]}***${email.slice(at)}`;
}

export * from './render';
export * from './unsubscribe';

export type EmailData<T extends TemplateKey> = z.infer<Templates[T]['schema']>;
export type EmailTemplate = keyof Templates;

/**
 * The Cloudflare Email Service `send_email` binding (Workers API). Declared
 * structurally so the package doesn't depend on @cloudflare/workers-types.
 * See https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export interface SendEmailBinding {
  send(message: {
    from: string | { email: string; name?: string };
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface SentEmail {
  messageId: string;
}

function getSender() {
  const email = process.env.EMAIL_SENDER ?? 'hello@openpanel.dev';
  const name = process.env.EMAIL_SENDER_NAME;
  return name ? { email, name } : email;
}

function getEmailCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  if (error instanceof Error) {
    // Email Service errors carry codes like E_SENDER_NOT_VERIFIED in the message.
    return error.message.match(/\bE_[A-Z_]+\b/)?.[0];
  }
  return undefined;
}

/**
 * Render a template and send it through Cloudflare Email Service.
 *
 * Returns `null` whenever the email was not sent — invalid data, the
 * recipient unsubscribed from the category, no `EMAIL` binding, or a send
 * error — so callers that must know about delivery (email sequences) can
 * treat `null` as "not sent".
 */
export async function sendEmail<T extends TemplateKey>(
  templateKey: T,
  options: {
    to: string;
    data: z.infer<Templates[T]['schema']>;
  },
): Promise<SentEmail | null> {
  const { to, data } = options;
  const template = templates[templateKey];
  const props = template.schema.safeParse(data);

  if (!props.success) {
    console.error('Failed to parse data', props.error);
    return null;
  }

  if ('category' in template && template.category) {
    const unsubscribed = await db.emailUnsubscribe.findUnique({
      where: {
        email_category: {
          email: to,
          category: template.category,
        },
      },
    });

    if (unsubscribed) {
      console.log(
        `Skipping email to ${redactEmail(to)} - unsubscribed from ${template.category}`,
      );
      return null;
    }
  }

  const headers: Record<string, string> = {};
  if ('category' in template && template.category) {
    const unsubscribeUrl = getUnsubscribeUrl(to, template.category);
    (props.data as any).unsubscribeUrl = unsubscribeUrl;
    // Both are on Email Service's custom-header allowlist.
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const binding = getEnv<{ EMAIL?: SendEmailBinding }>().EMAIL;
  if (!binding) {
    // Never dump the payload: template data carries password-reset and
    // unsubscribe links, and the recipient is personal data
    // (GHSA-xr2x-w49w-hp2c).
    console.warn(
      `Email not sent (email_provider_not_configured): template=${templateKey} to=${redactEmail(to)}`,
    );
    return null;
  }

  try {
    const { subject, html, text } = await renderTemplate(
      templateKey,
      props.data as any,
    );
    const result = await binding.send({
      from: getSender(),
      to,
      subject,
      html,
      text,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    return { messageId: result.messageId };
  } catch (error) {
    console.error('Failed to send email via Cloudflare Email Service', {
      template: templateKey,
      to: redactEmail(to),
      code: getEmailCode(error),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
