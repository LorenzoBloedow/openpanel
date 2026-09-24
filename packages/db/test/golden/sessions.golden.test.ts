import * as sessions from './cases/sessions.cases';
import { describeGoldenGroup } from './compare';

describeGoldenGroup(sessions.group, sessions.cases);
