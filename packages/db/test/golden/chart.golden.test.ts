import * as chart from './cases/chart.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(chart.group, chart.cases);
