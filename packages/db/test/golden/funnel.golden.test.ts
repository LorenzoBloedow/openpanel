import * as funnel from './cases/funnel.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(funnel.group, funnel.cases);
