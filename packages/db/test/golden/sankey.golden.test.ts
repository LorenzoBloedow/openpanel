import * as sankey from './cases/sankey.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(sankey.group, sankey.cases);
