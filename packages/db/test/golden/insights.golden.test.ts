import * as insights from './cases/insights.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(insights.group, insights.cases);
