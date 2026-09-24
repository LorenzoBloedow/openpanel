import { collectBySlug } from './content-json';

export interface FeatureSeo {
  title: string;
  description: string;
  keywords?: string[];
}

export interface FeatureHero {
  heading: string;
  subheading: string;
  badges: string[];
}

export interface FeatureDefinition {
  title?: string;
  text: string;
}

export interface FeatureCapability {
  title: string;
  description: string;
  icon?: string;
}

export interface FeatureCapabilitiesSection {
  title: string;
  intro?: string;
}

export interface FeatureScreenshot {
  src?: string;
  srcDark?: string;
  srcLight?: string;
  alt: string;
  caption?: string;
}

export interface FeatureHowItWorksStep {
  title: string;
  description: string;
}

export interface FeatureHowItWorks {
  title: string;
  intro?: string;
  steps: FeatureHowItWorksStep[];
}

export interface FeatureUseCase {
  title: string;
  description: string;
  icon?: string;
}

export interface FeatureUseCases {
  title: string;
  intro?: string;
  items: FeatureUseCase[];
}

export interface RelatedFeature {
  slug: string;
  title: string;
  description?: string;
}

export interface FeatureFaq {
  question: string;
  answer: string;
}

export interface FeatureFaqs {
  title: string;
  intro?: string;
  items: FeatureFaq[];
}

export interface FeatureCta {
  label: string;
  href: string;
}

export interface FeatureData {
  url: string;
  slug: string;
  /** Short internal name for nav, footer, etc. (e.g. "Event tracking") */
  short_name: string;
  seo: FeatureSeo;
  hero: FeatureHero;
  definition: FeatureDefinition;
  capabilities: FeatureCapability[];
  capabilities_section?: FeatureCapabilitiesSection;
  screenshots: FeatureScreenshot[];
  how_it_works?: FeatureHowItWorks;
  use_cases: FeatureUseCases;
  related_features: RelatedFeature[];
  faqs: FeatureFaqs;
  cta: FeatureCta;
}

const featureBySlug: Map<string, FeatureData> = collectBySlug(
  import.meta.glob<Omit<FeatureData, 'url'>>('/content/features/*.json', {
    eager: true,
    import: 'default',
  }),
  '/features',
);

export async function getFeatureData(
  slug: string,
): Promise<FeatureData | null> {
  return featureBySlug.get(slug) ?? null;
}

export async function getAllFeatureSlugs(): Promise<string[]> {
  return [...featureBySlug.keys()];
}

export async function loadFeatureSource(): Promise<FeatureData[]> {
  return loadFeatureSourceSync();
}

/** Sync loader for use in source.ts (same pattern as compareSource). */
export function loadFeatureSourceSync(): FeatureData[] {
  return [...featureBySlug.values()];
}
