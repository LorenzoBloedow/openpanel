import * as groups from './cases/groups.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(groups.group, groups.cases);
