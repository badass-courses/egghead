import { mergeConfig } from "vitest/config";
import config from "./vitest.workshops.config";

export default mergeConfig(config, { test: { include: ["test/workshops-mysql/**/*.test.ts"] } });
