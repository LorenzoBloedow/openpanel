import * as pages from './cases/pages.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(pages.group, pages.cases);
