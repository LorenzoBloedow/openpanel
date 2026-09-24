import * as cohorts from './cases/cohorts.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(cohorts.group, cohorts.cases);
