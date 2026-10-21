import { createCapacitorPlatformTestDouble } from './platformTestDoubles'

// @@@mutable-platform-double - tests mutate this singleton while the mocked platform module reads the same object.
export const platform = createCapacitorPlatformTestDouble()
