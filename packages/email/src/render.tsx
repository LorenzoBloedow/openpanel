import { render } from '@react-email/render';
import React from 'react';
import type { z } from 'zod';

import { type TemplateKey, type Templates, templates } from './emails';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render a template to its subject, HTML and plain-text bodies. `props` must
 * already be validated against the template's schema; sendEmail adds the
 * unsubscribe link after validation, since the schemas strip unknown keys.
 */
export async function renderTemplate<T extends TemplateKey>(
  templateKey: T,
  props: z.infer<Templates[T]['schema']> & { unsubscribeUrl?: string },
): Promise<RenderedEmail> {
  const template = templates[templateKey];
  const element = <template.Component {...(props as any)} />;
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: template.subject(props as any), html, text };
}
