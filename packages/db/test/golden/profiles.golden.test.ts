import * as profiles from './cases/profiles.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(profiles.group, profiles.cases);
