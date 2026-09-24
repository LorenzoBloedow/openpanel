import * as conversion from './cases/conversion.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(conversion.group, conversion.cases);
