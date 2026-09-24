import * as counts from './cases/counts.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(counts.group, counts.cases);
