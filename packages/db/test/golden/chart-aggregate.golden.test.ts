import * as chartAggregate from './cases/chart-aggregate.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(chartAggregate.group, chartAggregate.cases);
