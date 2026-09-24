import * as events from './cases/events.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(events.group, events.cases);
