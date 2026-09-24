import * as retention from './cases/retention.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(retention.group, retention.cases);
