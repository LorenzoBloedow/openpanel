import { collectBySlug } from './content-json';

export interface ForSeo {
  title: string;
  description: string;
  noindex?: boolean;
}

export interface ForHero {
  heading: string;
  subheading: string;
  badges: string[];
}

export interface ForProblem {
  title: string;
  intro: string;
  items: Array<{
    title: string;
    description: string;
  }>;
}

export interface ForFeature {
  title: string;
  description: string;
  icon?: string;
}

export interface ForFeatures {
  title: string;
  intro: string;
  items: ForFeature[];
}

export interface ForBenefit {
  title: string;
  description: string;
}

export interface ForBenefits {
  title: string;
  intro: string;
  items: ForBenefit[];
}

export interface ForFaq {
  question: string;
  answer: string;
}

export interface ForFaqs {
  title: string;
  intro: string;
  items: ForFaq[];
}

export interface ForCta {
  label: string;
  href: string;
}

export interface ForRelatedLinks {
  articles?: Array<{ title: string; url: string }>;
  guides?: Array<{ title: string; url: string }>;
  comparisons?: Array<{ title: string; url: string }>;
}

export interface ForData {
  url: string;
  slug: string;
  audience: string;
  seo: ForSeo;
  hero: ForHero;
  problem: ForProblem;
  features: ForFeatures;
  benefits: ForBenefits;
  faqs: ForFaqs;
  related_links?: ForRelatedLinks;
  ctas: {
    primary: ForCta;
    secondary: ForCta;
  };
}

const forBySlug: Map<string, ForData> = collectBySlug(
  import.meta.glob<Omit<ForData, 'url'>>('/content/for/*.json', {
    eager: true,
    import: 'default',
  }),
  '/for',
);

export async function getForData(slug: string): Promise<ForData | null> {
  return forBySlug.get(slug) ?? null;
}

export async function getAllForSlugs(): Promise<string[]> {
  return [...forBySlug.keys()];
}
