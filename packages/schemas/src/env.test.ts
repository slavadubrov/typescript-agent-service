import { beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnv } from "./env.ts";

describe("loadEnv", () => {
    beforeEach(resetEnv);

    it("applies defaults for everything optional", () => {
        const env = loadEnv({});
        expect(env.PORT).toBe(8080);
        expect(env.NODE_ENV).toBe("development");
        expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
    });

    it("coerces PORT from the string the OS actually provides", () => {
        // `process.env` values are always strings. This is the single most
        // common source of `"8080" + 1 === "80801"` bugs.
        expect(loadEnv({ PORT: "3000" }).PORT).toBe(3000);
    });

    it("names the offending variable when validation fails", () => {
        expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(/PORT/);
    });

    it("rejects a base URL with no scheme", () => {
        // "localhost:8000" parses as a URL whose scheme is "localhost:", so a
        // bare z.url() lets it through. The protocol constraint is what makes
        // this fail here instead of inside the HTTP client.
        expect(() => loadEnv({ OPENAI_BASE_URL: "localhost:8000" })).toThrow(/OPENAI_BASE_URL/);
    });

    it("accepts a self-hosted vLLM endpoint", () => {
        expect(loadEnv({ OPENAI_BASE_URL: "http://localhost:8000/v1" }).OPENAI_BASE_URL).toBe(
            "http://localhost:8000/v1",
        );
    });

    it("caches after the first successful parse", () => {
        expect(loadEnv({ PORT: "3000" })).toBe(loadEnv({ PORT: "9999" }));
    });
});
