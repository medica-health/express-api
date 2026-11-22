// Loaded before every test file (bunfig.toml). Provides the env that config/env.ts requires.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.JWT_ISSUER = "cdac-auth";
process.env.JWT_AUDIENCE = "cdac-api";
process.env.JOBS_ENABLED = "false";
process.env.RESEND_API_KEY = "re_test_dummy_key"; // deliver() tests stub fetch; nothing leaves the machine
process.env.TWILIO_ACCOUNT_SID = "AC_test"; // sms tests stub fetch
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_SMS_FROM = "+15005550006";
// Redis-backed tests (src/test/redis.test.ts) run only when TEST_REDIS_URL points at a disposable
// Redis, e.g. TEST_REDIS_URL=redis://localhost:6379/15 bun test. Otherwise Redis is off (fail-open paths).
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "";
