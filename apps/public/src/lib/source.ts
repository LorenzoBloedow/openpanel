import {
  articleCollection,
  docs,
  guideCollection,
  pageCollection,
} from 'collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server';
import { OPENPANEL_BASE_URL } from './openpanel-brand';
import { type CompareData, getAllCompareData } from './compare';
import { type FeatureData, loadFeatureSourceSync } from './features';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const articleSource = loader({
  baseUrl: '/articles',
  source: toFumadocsSource(articleCollection, []),
  plugins: [lucideIconsPlugin()],
});

export const pageSource = loader({
  baseUrl: '/',
  source: toFumadocsSource(pageCollection, []),
});

export const guideSource = loader({
  baseUrl: '/guides',
  source: toFumadocsSource(guideCollection, []),
  plugins: [lucideIconsPlugin()],
});

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `/og/docs/${segments.join('/')}`,
  };
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText('processed');
  const canonical = `${OPENPANEL_BASE_URL}${page.url}`;

  return `---
## ${page.data.title}
URL: ${canonical}

${processed}`;
}

export const compareSource: CompareData[] = getAllCompareData();

export const featureSource: FeatureData[] = loadFeatureSourceSync();
