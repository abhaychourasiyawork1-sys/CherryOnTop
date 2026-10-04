// The production modules the runner needs besides the simulator, in one place.
import { learnFromTask } from '../../dist/governor/governor.js';
import { emptyGovernorMemory } from '../../dist/governor/memory.js';
import { createDormantPool } from '../../dist/governor/coverage.js';

export { learnFromTask };
export const emptyGovernorMemoryFn = () => emptyGovernorMemory();
export const createDormantPoolFn = () => createDormantPool();
