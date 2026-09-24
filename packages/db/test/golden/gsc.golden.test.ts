import * as gsc from './cases/gsc.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(gsc.group, gsc.cases);
